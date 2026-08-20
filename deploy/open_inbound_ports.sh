#!/bin/bash
# AWS 보안 그룹 인바운드 규칙 추가 (로컬에서 AWS CLI + 자격증명 필요)
# Usage: bash deploy/open_inbound_ports.sh [SECURITY_GROUP_ID]

set -e

SG_ID="${1:-}"

if [ -z "$SG_ID" ]; then
  echo "보안 그룹 ID를 찾는 중..."
  INSTANCE_ID=$(aws ec2 describe-instances \
    --filters "Name=ip-address,Values=3.34.197.18" \
    --query "Reservations[0].Instances[0].InstanceId" \
    --output text 2>/dev/null || true)

  if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
    INSTANCE_ID=$(aws ec2 describe-instances \
      --filters "Name=tag:Name,Values=*" "Name=instance-state-name,Values=running" \
      --query "Reservations[].Instances[?PublicIpAddress=='3.34.197.18'].InstanceId | [0]" \
      --output text 2>/dev/null || true)
  fi

  if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
    echo "ERROR: 인스턴스를 찾을 수 없습니다. 보안 그룹 ID를 직접 지정하세요:"
    echo "  bash deploy/open_inbound_ports.sh sg-xxxxxxxx"
    exit 1
  fi

  SG_ID=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" \
    --output text)
fi

echo "Security Group: $SG_ID"
echo "인바운드 규칙 추가 중..."

add_rule() {
  local proto=$1 port=$2 desc=$3
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=${proto},FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=0.0.0.0/0,Description=${desc}}]" \
    2>/dev/null && echo "  OK: ${proto}/${port} (${desc})" || echo "  SKIP: ${proto}/${port} (이미 존재하거나 오류)"
}

add_udp_range() {
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=udp,FromPort=1024,ToPort=65535,IpRanges=[{CidrIp=0.0.0.0/0,Description=WebRTC-media}]" \
    2>/dev/null && echo "  OK: udp/1024-65535 (WebRTC)" || echo "  SKIP: udp/1024-65535 (이미 존재하거나 오류)"
}

# 필수
add_rule tcp 22  SSH
add_rule tcp 80  HTTP
add_rule tcp 443 HTTPS

# WebRTC (영상/음성 P2P)
add_udp_range

echo ""
echo "완료! http://3.34.197.18 접속 테스트"
