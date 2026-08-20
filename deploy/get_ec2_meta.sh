#!/bin/bash
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
HDR="X-aws-ec2-metadata-token: $TOKEN"
echo "instance-id: $(curl -s -H "$HDR" http://169.254.169.254/latest/meta-data/instance-id)"
echo "security-groups: $(curl -s -H "$HDR" http://169.254.169.254/latest/meta-data/security-groups)"
MAC=$(curl -s -H "$HDR" http://169.254.169.254/latest/meta-data/network/interfaces/macs/ | head -1)
echo "sg-ids: $(curl -s -H "$HDR" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC}/security-group-ids")"
