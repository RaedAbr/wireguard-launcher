"""Checks the VPN template and runs its inline timer code against a fake AWS."""
import json
import os
import pathlib
import re
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Loader(yaml.SafeLoader):
    pass


def tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {suffix: value}


Loader.add_multi_constructor("!", tag)
TEMPLATE = yaml.load((ROOT / "template/vpn.yaml").read_text(), Loader=Loader)
RESOURCES = TEMPLATE["Resources"]
CODE = RESOURCES["Cleanup"]["Properties"]["Code"]["ZipFile"]


def references(value):
    """Logical ids that a resource points at, which CloudFormation treats as dependencies."""
    found = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "Ref" and isinstance(item, str):
                found.add(item)
            elif key == "GetAtt" and isinstance(item, str):
                found.add(item.split(".")[0])
            elif key == "Sub" and isinstance(item, str):
                found.update(re.findall(r"\$\{([A-Za-z0-9]+)[.}]", item))
            found |= references(item)
    elif isinstance(value, list):
        for item in value:
            found |= references(item)
    return found


def dependencies(name):
    resource = RESOURCES[name]
    depends = resource.get("DependsOn", [])
    depends = [depends] if isinstance(depends, str) else depends
    return (references(resource.get("Properties", {})) | set(depends)) & set(RESOURCES)


def reaches(name, target, seen=None):
    seen = seen or set()
    if name == target:
        return True
    seen.add(name)
    return any(reaches(d, target, seen) for d in dependencies(name) if d not in seen)


class FakeAws:
    def __init__(self, created=None):
        self.created = created
        self.deleted = []

    def client(self, name):
        return self

    def describe_availability_zones(self, Filters):
        return {"AvailabilityZones": [{"ZoneName": "x-1a"}, {"ZoneName": "x-1b"}, {"ZoneName": "x-1c"}]}

    def describe_instance_type_offerings(self, LocationType, Filters):
        return {"InstanceTypeOfferings": [{"Location": "x-1c"}, {"Location": "x-1b"}]}

    def describe_stacks(self, StackName):
        return {"Stacks": [{"CreationTime": self.created}]}

    def delete_stack(self, StackName):
        self.deleted.append(StackName)


def run_code(aws):
    sys.modules["boto3"] = types.SimpleNamespace(client=aws.client)
    scope = {}
    exec(compile(CODE, "index.py", "exec"), scope)
    return scope


def custom_event(kind):
    return {
        "RequestType": kind, "ResponseURL": "https://example.test/reply", "StackId": "stack",
        "RequestId": "request", "LogicalResourceId": "Zone",
        "ResourceProperties": {"InstanceType": "t3.micro"},
    }


class Timer(unittest.TestCase):
    def call(self, scope, event):
        with mock.patch("urllib.request.urlopen") as sent:
            scope["handler"](event, None)
        return json.loads(sent.call_args.args[0].data)

    def test_picks_first_zone_offering_the_server_type(self):
        reply = self.call(run_code(FakeAws()), custom_event("Create"))
        self.assertEqual(reply["Status"], "SUCCESS")
        self.assertEqual(reply["Data"]["Name"], "x-1b")

    def test_reports_failure_when_no_zone_offers_it(self):
        aws = FakeAws()
        aws.describe_instance_type_offerings = lambda **_: {"InstanceTypeOfferings": []}
        self.assertEqual(self.call(run_code(aws), custom_event("Create"))["Status"], "FAILED")

    def test_stack_delete_always_succeeds(self):
        aws = FakeAws()
        aws.describe_availability_zones = None
        self.assertEqual(self.call(run_code(aws), custom_event("Delete"))["Status"], "SUCCESS")

    def tick(self, age_hours):
        aws = FakeAws(datetime.now(timezone.utc) - timedelta(hours=age_hours))
        with mock.patch.dict(os.environ, {"STACK_ID": "stack", "MINUTES": "20"}):
            run_code(aws)["handler"]({"source": "aws.events"}, None)
        return aws.deleted

    def test_keeps_the_vpn_before_its_time(self):
        self.assertEqual(self.tick(19 / 60), [])

    def test_deletes_the_vpn_when_its_time_is_up(self):
        self.assertEqual(self.tick(21 / 60), ["stack"])

    def test_inline_code_fits_the_limit(self):
        self.assertLess(len(CODE), 4096)


class Template(unittest.TestCase):
    def test_role_is_deleted_last(self):
        for name in RESOURCES:
            if name != "CleanupRole":
                self.assertTrue(reaches(name, "CleanupRole"), f"{name} could outlive the role")

    def test_only_the_wireguard_port_is_open(self):
        rules = RESOURCES["Firewall"]["Properties"]["SecurityGroupIngress"]
        self.assertEqual([(r["IpProtocol"], r["FromPort"], r["ToPort"]) for r in rules], [("udp", 51820, 51820)])

    def test_server_shutdown_removes_it_and_its_disk(self):
        server = RESOURCES["Server"]["Properties"]
        self.assertEqual(server["InstanceInitiatedShutdownBehavior"], "terminate")
        self.assertTrue(server["BlockDeviceMappings"][0]["Ebs"]["DeleteOnTermination"])

    def test_quick_create_can_fill_every_parameter(self):
        self.assertFalse(any(p.get("NoEcho") for p in TEMPLATE["Parameters"].values()))

    def test_role_cannot_grant_access(self):
        statements = RESOURCES["CleanupRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        actions = [a for s in statements for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])]
        self.assertFalse([a for a in actions if a.startswith("iam:") and not re.match(r"iam:(Delete|Get|List)", a)])
        self.assertNotIn("iam:PassRole", actions)


class Page(unittest.TestCase):
    def test_one_device_limit_is_stated(self):
        self.assertIn("One VPN works on one device", (ROOT / "docs/index.html").read_text())
        self.assertIn("One VPN, one device", (ROOT / "docs/app.js").read_text())
        self.assertIn("one device", (ROOT / "README.md").read_text().lower())

    def test_page_may_not_send_data_anywhere(self):
        csp = re.search(r'Content-Security-Policy" content="([^"]+)"', (ROOT / "docs/index.html").read_text()).group(1)
        self.assertIn("default-src 'none'", csp)
        self.assertNotIn("connect-src", csp)


if __name__ == "__main__":
    unittest.main()
