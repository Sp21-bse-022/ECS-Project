# Learning AWS ECS with this project

This repo is a minimal Node.js/Express app whose only real purpose is to give
you something small and real to deploy to **AWS ECS (Elastic Container
Service)**. Read the concepts section first, then work through the hands-on
walkthrough using the actual files in this repo.

---

## 1. Core concepts (the vocabulary)

ECS has a handful of building blocks. Once these click, the console/CLI stops
being confusing.

### Cluster
A logical grouping of compute where your containers run. A cluster doesn't
"do" anything by itself — it's just a namespace that tasks and services live
in.

### Task definition
A JSON blueprint (see `ecs/task-definition.json`) describing **how to run**
one or more containers: which image, how much CPU/memory, which ports,
environment variables, logging config, and IAM roles. Think of it like a
`docker-compose.yml` that ECS understands. Every time you change it and
register it, you get a new **revision** (`ecs-learning-app:1`,
`:2`, `:3`, ...) — old revisions aren't deleted, so rollbacks are just
"point the service at an older revision."

### Task
A **running instance** of a task definition — the actual container(s)
executing right now. One task definition can be running as many tasks at
once (that's how you scale horizontally).

### Service
Keeps a desired number of tasks running. If a task crashes or its health
check fails, the service replaces it. Services are also what you attach to a
load balancer, and what autoscaling (`ecs:UpdateService`) actually controls.
Without a service, a "task" you launch directly just runs once and stops —
services are what give you "always N copies running."

### Launch types: Fargate vs EC2
- **Fargate** — serverless. You just say "run this task def," and AWS
  provisions the underlying compute for you. No EC2 instances to patch or
  size. Slightly higher cost per vCPU/GB, but zero infra management. This is
  what `ecs/task-definition.json` in this repo is configured for
  (`requiresCompatibilities: ["FARGATE"]`), and what's recommended for
  learning.
- **EC2 launch type** — you manage a fleet of EC2 instances (an ECS-optimized
  AMI running the ECS agent) and ECS schedules containers onto them like a
  mini Kubernetes. Cheaper at scale, more to manage.

### Networking (`awsvpc` mode)
With `awsvpc` network mode (required for Fargate), every task gets its own
elastic network interface and private IP inside your VPC — it behaves like a
tiny EC2 instance, not like classic Docker port-mapping. This is why the task
definition doesn't map host ports; it just declares `containerPort`.

### IAM roles — two different ones, don't confuse them
- **Task execution role** (`executionRoleArn` in the task def) — used by the
  *ECS agent itself* to pull your image from ECR and write logs to
  CloudWatch. AWS ships a managed policy for this:
  `AmazonECSTaskExecutionRolePolicy`.
- **Task role** (`taskRoleArn`, not set in our template) — used by *your
  application code* at runtime to call other AWS services (S3, DynamoDB,
  etc.), via the same credential-injection mechanism as EC2 instance
  profiles. Our app doesn't call AWS APIs, so we skip it — but this is the
  thing you'd add for a real app.

### Load balancer (ALB)
An Application Load Balancer sits in front of a service, distributes traffic
across tasks, and — importantly — is what runs the HTTP health check that
decides whether a task is "healthy" and should keep receiving traffic. Our
app's `/health` endpoint exists specifically to be that target.

### ECR (Elastic Container Registry)
AWS's private Docker registry. ECS pulls your image from here, not from
Docker Hub (though it can pull from Docker Hub too — ECR is just the
common/private default).

### Logging
`awslogs` log driver in the task definition ships container stdout/stderr to
CloudWatch Logs. `"awslogs-create-group": "true"` lets ECS create the log
group automatically instead of you pre-creating it.

---

## 2. How the pieces connect

```
Your laptop                 ECR                         ECS
┌──────────┐   docker push  ┌────────┐  task def points  ┌─────────────┐
│ Dockerfile│ ─────────────▶│  image │◀──────────────────│Task Definition│
└──────────┘                └────────┘                    └──────┬───────┘
                                                                  │ runs as
                                                                  ▼
                                                          ┌───────────────┐        ┌─────┐
                                                          │    Service    │◀──────▶│ ALB │◀── users
                                                          │ (N tasks kept │ health  └─────┘
                                                          │   running)    │ checks
                                                          └───────────────┘
                                                                  │
                                                                  ▼
                                                          CloudWatch Logs
```

---

## 3. Hands-on walkthrough

### Step 0 — Prerequisites
- AWS account + [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured (`aws configure`)
- Docker installed and running
- An AWS region in mind (e.g. `us-east-1`)

### Step 1 — Run it locally first
Always verify the app works outside ECS before adding cloud complexity.

```bash
npm install
npm start
# in another terminal:
curl localhost:3968/health
curl localhost:3968/
curl localhost:3968/api/info
```

Or with Docker:

```bash
docker compose up --build
```

Notice `/api/info` says `"Not running inside ECS"` — that's expected locally;
once deployed, it'll show real ECS task metadata (task ARN, cluster, etc.)
because ECS injects `ECS_CONTAINER_METADATA_URI_V4` into every container.

### Step 2 — Create an ECR repository

```bash
aws ecr create-repository --repository-name ecs-learning-app --region <your-region>
```

### Step 3 — Create an ECS cluster (Fargate)

```bash
aws ecs create-cluster --cluster-name ecs-learning-cluster --region <your-region>
```

### Step 4 — Create the task execution role (one-time, if you don't have one)

```bash
aws iam create-role --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

### Step 5 — Build, push, and register using the helper script

Fill in the required env vars and run `ecs/deploy.sh` (do this from inside
the `ecs/` directory — the script builds using the parent folder as context):

```bash
cd ecs
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=123456789012
export ECR_REPO_NAME=ecs-learning-app
export ECS_CLUSTER_NAME=ecs-learning-cluster
export ECS_SERVICE_NAME=ecs-learning-app-service   # created in step 6, first run will fail on update-service — that's fine
./deploy.sh
```

The script:
1. Logs Docker into ECR
2. Builds the image from the Dockerfile
3. Tags and pushes it to ECR
4. Renders `task-definition.json` with your real account/region values
5. Registers the task definition with ECS
6. Tries to force-redeploy the service (skip/ignore this step before the
   service exists — see Step 6)

Before running it, open `ecs/task-definition.json` and replace
`REPLACE_WITH_ecsTaskExecutionRole_ARN` with the ARN from Step 4
(`arn:aws:iam::<account-id>:role/ecsTaskExecutionRole`).

### Step 6 — Create the service (first time only)

This is the one step best done via the console the first time, because it
involves picking a VPC, subnets, a security group (open port 3968, or 80 if
you put an ALB in front), and optionally creating an Application Load
Balancer. Via CLI it looks like:

```bash
aws ecs create-service \
  --cluster ecs-learning-cluster \
  --service-name ecs-learning-app-service \
  --task-definition ecs-learning-app \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-XXXX],securityGroups=[sg-XXXX],assignPublicIp=ENABLED}"
```

`assignPublicIp=ENABLED` is only for quick learning/testing so you can hit
the task's public IP directly without setting up an ALB. For anything real,
put tasks in private subnets behind an ALB instead.

### Step 7 — Verify

```bash
aws ecs describe-services --cluster ecs-learning-cluster --services ecs-learning-app-service
```

Find the task's public IP (via `aws ecs describe-tasks` → ENI → EC2 describe
network-interfaces), then:

```bash
curl http://<task-public-ip>:3968/
curl http://<task-public-ip>:3968/api/info   # now shows real ECS task metadata
```

### Step 8 — Make a change and redeploy

Edit `src/server.js`, then re-run `ecs/deploy.sh`. This time step 6 (update
service) will actually work since the service already exists. ECS performs a
rolling deployment: starts new tasks, waits for them to pass the health
check, then drains and stops the old ones — which is exactly why the app
handles `SIGTERM` gracefully and exposes `/health`.

### Step 9 — Clean up (avoid ongoing charges)

```bash
aws ecs update-service --cluster ecs-learning-cluster --service ecs-learning-app-service --desired-count 0
aws ecs delete-service --cluster ecs-learning-cluster --service ecs-learning-app-service
aws ecs delete-cluster --cluster-name ecs-learning-cluster
aws ecr delete-repository --repository-name ecs-learning-app --force
```

---

## 4. Things worth experimenting with next

- **Autoscaling**: register the service as a scalable target with
  Application Auto Scaling and scale on CPU/memory or request count.
- **Blue/green deploys**: swap the rolling-update deployment controller for
  CodeDeploy to get traffic-shifting deployments.
- **Service discovery**: use AWS Cloud Map so other services can find this
  one by DNS name instead of an IP.
- **Secrets**: instead of plaintext `environment` values, reference AWS
  Secrets Manager or SSM Parameter Store via the task definition's `secrets`
  field.
- **Infrastructure as code**: once the manual flow makes sense, redo Steps
  2–6 in Terraform or AWS CDK so the whole stack is reproducible.

---

## 5. Files in this repo, at a glance

| File | Purpose |
|---|---|
| `src/server.js` | The Express app (`/`, `/health`, `/api/info`) |
| `Dockerfile` | Builds the production container image |
| `docker-compose.yml` | Run the container locally without touching AWS |
| `ecs/task-definition.json` | The Fargate task definition template |
| `ecs/deploy.sh` | Scripted build → push → register → deploy flow |
