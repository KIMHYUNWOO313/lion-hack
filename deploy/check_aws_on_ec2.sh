#!/bin/bash
set -e

echo "=== AWS CLI ==="
which aws 2>/dev/null || echo "aws not installed"

echo "=== IAM Role ==="
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
HDR="X-aws-ec2-metadata-token: $TOKEN"
ROLE=$(curl -s -H "$HDR" http://169.254.169.254/latest/meta-data/iam/security-credentials/ 2>/dev/null || echo "none")
echo "role: $ROLE"

if [ -n "$ROLE" ] && [ "$ROLE" != "none" ] && [ "$ROLE" != "404" ]; then
  aws sts get-caller-identity 2>&1 || true
fi

echo "=== Current SG rules (if aws works) ==="
SG_ID="sg-0287773754c59b81e"
aws ec2 describe-security-groups --group-ids "$SG_ID" --query "SecurityGroups[0].IpPermissions" --output table 2>&1 || echo "cannot describe SG"
