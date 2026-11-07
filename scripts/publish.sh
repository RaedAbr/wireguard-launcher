#!/usr/bin/env bash
# One-time step for whoever hosts the page, and again whenever template/vpn.yaml
# changes. Uploads the template to a public S3 path and points the page at it.
# Usage: scripts/publish.sh <bucket> <bucket-region>
set -euo pipefail
BUCKET="${1:?usage: publish.sh <bucket> <bucket-region>}"
REGION="${2:?usage: publish.sh <bucket> <bucket-region>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/template/vpn.yaml"

VERSION="$(sha256sum "$TEMPLATE" | cut -c1-12)"
KEY="templates/vpn-$VERSION.yaml"

aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws s3 mb "s3://$BUCKET" --region "$REGION"

# Only the templates/ path becomes public, and it holds nothing secret.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicTemplates\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/templates/*\"
  }]
}"
aws s3 cp --region "$REGION" "$TEMPLATE" "s3://$BUCKET/$KEY"

URL="https://$BUCKET.s3.$REGION.amazonaws.com/$KEY"
sed -i.bak "s|<meta name=\"wgl-template\" content=\"[^\"]*\">|<meta name=\"wgl-template\" content=\"$URL\">|" "$ROOT/docs/index.html"
rm -f "$ROOT/docs/index.html.bak"

echo
echo "Template: $URL"
echo "docs/index.html now uses it. Commit and push so the live page picks it up."
