#!/usr/bin/env bash
# Helper script that walks through the manual steps of shipping this app to ECS.
# Meant for learning: read each step before running it, don't just execute blindly.
#
# Required env vars:
#   AWS_REGION          e.g. us-east-1
#   AWS_ACCOUNT_ID       your 12-digit account id
#   ECR_REPO_NAME        e.g. ecs-learning-app
#   ECS_CLUSTER_NAME     e.g. ecs-learning-cluster
#   ECS_SERVICE_NAME     e.g. ecs-learning-app-service
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION}"
: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
: "${ECR_REPO_NAME:?set ECR_REPO_NAME}"
: "${ECS_CLUSTER_NAME:?set ECS_CLUSTER_NAME}"
: "${ECS_SERVICE_NAME:?set ECS_SERVICE_NAME}"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "==> 1. Authenticating Docker to ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "==> 2. Building the image"
docker build -t "$ECR_REPO_NAME" ..

echo "==> 3. Tagging and pushing to ECR"
docker tag "$ECR_REPO_NAME:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

echo "==> 4. Rendering task definition with real values"
sed \
  -e "s|REPLACE_WITH_ECR_IMAGE_URI:latest|${ECR_URI}:latest|" \
  -e "s|REPLACE_WITH_AWS_REGION|${AWS_REGION}|" \
  task-definition.json > task-definition.rendered.json
echo "   NOTE: still replace REPLACE_WITH_ecsTaskExecutionRole_ARN by hand (or export and sed it too)."

echo "==> 5. Registering the new task definition revision"
aws ecs register-task-definition \
  --cli-input-json file://task-definition.rendered.json \
  --region "$AWS_REGION"

echo "==> 6. Updating the service to use the latest task definition"
aws ecs update-service \
  --cluster "$ECS_CLUSTER_NAME" \
  --service "$ECS_SERVICE_NAME" \
  --task-definition ecs-learning-app \
  --force-new-deployment \
  --region "$AWS_REGION"

echo "==> Done. Watch the rollout with:"
echo "    aws ecs describe-services --cluster $ECS_CLUSTER_NAME --services $ECS_SERVICE_NAME --region $AWS_REGION"
