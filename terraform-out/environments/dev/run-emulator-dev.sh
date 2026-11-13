#!/usr/bin/env bash
# ============================================================================
# LocalCloud Studio — AWS Emulator Launcher & SDK Environment Setup
# Active Environment: Development (dev)
#
# Multi-Environment Port Allocation:
#   dev      -> Port 9297 (us-east-1)
#   testing  -> Port 9298 (us-east-1)
#   staging  -> Port 9299 (us-west-2)
#   prod     -> Port 9300 (us-west-2)
# ============================================================================
set -euo pipefail

PORT=9297
REGION="us-east-1"
ENV_NAME="dev"

mkdir -p "$HOME/.aws/emulator"

echo "🚀 Configuring shell for AWS Emulator [$ENV_NAME] on https://127.0.0.1:$PORT ($REGION)..."

# 1. Export AWS SDK / CLI / Terraform environment variables for aws-emulator
export AWS_ENDPOINT_URL="https://127.0.0.1:$PORT"
export AWS_SHARED_CREDENTIALS_FILE="$HOME/.aws/emulator/$PORT/emulator_credentials"
export AWS_CONFIG_FILE="$HOME/.aws/emulator/$PORT/config"
export AWS_CA_BUNDLE="$HOME/.aws/emulator/$PORT/ca.pem"
export NODE_EXTRA_CA_CERTS="$HOME/.aws/emulator/$PORT/ca.pem"
export AWS_EC2_METADATA_DISABLED="true"
export AWS_DISABLE_HOST_PREFIX_INJECTION="true"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
export EMULATOR_TELEMETRY="off"

# 2. Unset real AWS credentials so requests are signed with emulator keys
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE || true

# 3. Health check helper
check_health() {
  curl -sf --cacert "$HOME/.aws/emulator/$PORT/ca.pem" "https://127.0.0.1:$PORT/__admin/health" >/dev/null 2>&1
}

if check_health; then
  echo "✅ AWS Emulator [$ENV_NAME] is healthy on https://127.0.0.1:$PORT"
else
  echo "⚠️  AWS Emulator is not running yet on port $PORT. Start it via Docker:"
  echo "   docker run --rm -d --name aws-emulator-$ENV_NAME --memory=2g --memory-swap=2g \\"
  echo "     -p 127.0.0.1:$PORT:$PORT -e HOME="$HOME" \\"
  echo "     -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \\"
  echo "     aws-emulator -p $PORT --telemetry off"
fi

# 4. Run Terraform against this environment
echo ""
echo "📦 To provision [dev] infrastructure into AWS Emulator:"
echo "   terraform init"
echo "   terraform apply -var-file="dev.tfvars" -auto-approve"
