# Learning AWS ECS + S3 with this project

This repo splits into two pieces, deployed two different ways — which is
also the point: not everything belongs in a container.

- **`backend/`** — a minimal Node.js/Express API, containerized and run as
  an **AWS ECS (Fargate)** service.
- **`frontend/`** — a plain static HTML/JS page, uploaded to an **S3**
  bucket with static website hosting enabled, that calls the backend
  directly from the browser.

There is deliberately **no load balancer** in this setup. The frontend talks
straight to the ECS task's public IP. That's the simplest possible infra —
good for learning, with one real limitation explained in Step 6 below.

Read the concepts section first, then work through the hands-on walkthrough
using the actual files in this repo.

---

## 1. Core concepts (the vocabulary)

### Cluster
A logical grouping of compute where your containers run. A cluster doesn't
"do" anything by itself — it's just a namespace that tasks and services live
in.

### Task definition
A JSON blueprint (see `backend/ecs/task-definition.json`) describing **how
to run** one or more containers: which image, how much CPU/memory, which
ports, environment variables, logging config, and IAM roles. Think of it
like a `docker-compose.yml` that ECS understands. Every time you change it
and register it, you get a new **revision** (`ecs-learning-app:1`, `:2`,
`:3`, ...) — old revisions aren't deleted, so rollbacks are just "point the
service at an older revision."

### Task
A **running instance** of a task definition — the actual container(s)
executing right now. One task definition can be running as many tasks at
once (that's how you scale horizontally).

### Service
Keeps a desired number of tasks running. If a task crashes or its health
check fails, the service replaces it. Without a service, a "task" you launch
directly just runs once and stops — services are what give you "always N
copies running."

### Launch types: Fargate vs EC2
- **Fargate** — serverless. You just say "run this task def," and AWS
  provisions the underlying compute for you. This is what
  `backend/ecs/task-definition.json` is configured for
  (`requiresCompatibilities: ["FARGATE"]`), and what's recommended for
  learning.
- **EC2 launch type** — you manage a fleet of EC2 instances yourself and ECS
  schedules containers onto them. Cheaper at scale, more to manage. Not used
  here.

### Networking (`awsvpc` mode)
With `awsvpc` network mode (required for Fargate), every task gets its own
elastic network interface and IP inside your VPC — it behaves like a tiny
EC2 instance. In this setup we give the task a **public IP** directly
(`assignPublicIp=ENABLED`) since there's no load balancer to sit behind.

### IAM roles — two different ones, don't confuse them
- **Task execution role** (`executionRoleArn` in the task def) — used by the
  *ECS agent itself* to pull your image from ECR and write logs to
  CloudWatch. AWS ships a managed policy for this:
  `AmazonECSTaskExecutionRolePolicy`.
- **Task role** (`taskRoleArn`, not set in our template) — used by *your
  application code* at runtime to call other AWS services. Our app doesn't
  call AWS APIs, so we skip it — but this is the thing you'd add for a real
  app.

### CORS
Because the browser (loaded from an S3 origin) is calling the ECS task's IP
directly — a different origin — the backend needs to explicitly allow it.
That's what the `cors` middleware in `backend/src/server.js` and the
`CORS_ORIGIN` env var are for. With an ALB + custom domain you'd often avoid
this by putting both behind the same origin; without one, CORS is
unavoidable.

### ECR (Elastic Container Registry)
AWS's private Docker registry. ECS pulls your backend image from here.

### S3 static website hosting
An S3 bucket can serve plain HTML/JS/CSS files over HTTP directly, with no
server at all — you're paying for storage and bandwidth, not compute. Fine
for a static frontend like this one; not fine for anything needing
server-side logic, which is exactly why the API lives on ECS instead.

### Logging
`awslogs` log driver in the task definition ships container stdout/stderr to
CloudWatch Logs. `"awslogs-create-group": "true"` lets ECS create the log
group automatically instead of you pre-creating it.

---

## 2. How the pieces connect

```
Browser (loaded from S3)
      │  fetch('http://<task-public-ip>:3968/...')
      ▼
ECS Fargate Task  ◀── pulls image ── ECR  ◀── docker push ── backend/Dockerfile
      │
      ▼
CloudWatch Logs
```

No ALB, no DNS — the frontend just needs the task's current public IP
pasted into it. That's the trade-off called out in Step 6.

---

## 3. Hands-on walkthrough

### Step 0 — Prerequisites
- AWS account + [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured (`aws configure`)
- Docker installed and running
- An AWS region in mind (e.g. `us-east-1`)

### Step 1 — Run both pieces locally first
Always verify things work outside AWS before adding cloud complexity.

```bash
cd backend
npm install
npm start
# in another terminal:
curl localhost:3968/health
curl localhost:3968/
curl localhost:3968/api/info
```

Or with Docker: `docker compose up --build` (from inside `backend/`).

Then open `frontend/index.html` directly in a browser (no server needed),
paste `http://localhost:3968` into the "Backend URL" field, and click a
request button. This proves the CORS setup works before AWS is involved.

Notice `/api/info` says `"Not running inside ECS"` locally — once deployed,
it'll show real ECS task metadata because ECS injects
`ECS_CONTAINER_METADATA_URI_V4` into every container.

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

### Step 5 — Set up the GitHub Actions deploy user

Deploys are handled by `.github/workflows/deploy-backend.yml`, which builds
the image, pushes it to ECR, and updates the ECS service on every push to
`main` that touches `backend/`. It authenticates as a dedicated IAM user
using access keys stored as GitHub secrets — nothing manual to run per
deploy after this one-time setup.

Create the user and a scoped policy (replace `<region>` and
`<account-id>`):

```bash
aws iam create-user --user-name github-actions-ecs-deployer

cat > ci-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ECRAuth", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Sid": "ECRPush", "Effect": "Allow", "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchGetImage"
      ], "Resource": "arn:aws:ecr:<region>:<account-id>:repository/ecs-learning-app" },
    { "Sid": "ECSDeploy", "Effect": "Allow", "Action": [
        "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
        "ecs:DescribeServices", "ecs:UpdateService"
      ], "Resource": "*" },
    { "Sid": "PassExecutionRole", "Effect": "Allow", "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } }
  ]
}
EOF

aws iam put-user-policy --user-name github-actions-ecs-deployer \
  --policy-name ecs-deploy --policy-document file://ci-policy.json

aws iam create-access-key --user-name github-actions-ecs-deployer
```

`create-access-key` prints an `AccessKeyId`/`SecretAccessKey` pair **once** —
copy both immediately. In your GitHub repo, go to **Settings → Secrets and
variables → Actions** and add:

| Type | Name | Value |
|---|---|---|
| Secret | `AWS_ACCESS_KEY_ID` | from the command above |
| Secret | `AWS_SECRET_ACCESS_KEY` | from the command above |
| Variable | `AWS_REGION` | e.g. `us-east-1` |
| Variable | `ECR_REPOSITORY` | `ecs-learning-app` |
| Variable | `ECS_CLUSTER` | `ecs-learning-cluster` |
| Variable | `ECS_SERVICE` | `ecs-learning-app-service` |

Also fill in `backend/ecs/task-definition.json`: replace
`REPLACE_WITH_ecsTaskExecutionRole_ARN` with the role ARN from Step 4, and
commit it — the workflow reads this file directly and only overwrites its
`image` field.

### Step 6 — Bootstrap once by hand, then create the service

GitHub Actions can *update* an existing ECS service, but `create-service` is
a one-time resource you still create yourself. It also needs at least one
task definition revision and one image in ECR to point at first:

```bash
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com

docker build -t ecs-learning-app backend
docker tag ecs-learning-app:latest <account-id>.dkr.ecr.<region>.amazonaws.com/ecs-learning-app:bootstrap
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/ecs-learning-app:bootstrap
```

Edit the `image` field in `backend/ecs/task-definition.json` to that
`:bootstrap` URI just for this one registration, then:

```bash
aws ecs register-task-definition --cli-input-json file://backend/ecs/task-definition.json --region <region>
```

You can put the `REPLACE_WITH_ECR_IMAGE_URI:latest` placeholder back
afterward — the workflow overwrites this field on every run regardless, it
never reads it.

### Step 7 — Create the service, with a public IP and no load balancer

```bash
aws ecs create-service \
  --cluster ecs-learning-cluster \
  --service-name ecs-learning-app-service \
  --task-definition ecs-learning-app \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-XXXX],securityGroups=[sg-XXXX],assignPublicIp=ENABLED}"
```

The security group must allow inbound TCP 3968 from the internet (or at
least from your frontend's visitors) since there's no ALB doing that job.

**The trade-off**: without a load balancer or DNS name, the frontend has to
know the task's public IP, and that IP **changes** every time the task is
replaced (a crash, a new deploy, a scale event). That's fine for learning —
you just re-check the IP and re-paste it into the frontend — but it's the
first thing you'd fix (with an ALB + Route 53, or a Network Load Balancer
with a static IP) if this were headed to production. `desired-count: 1` also
means zero redundancy; bump it once you're ready to see the trade-off the
other direction (multiple IPs to track).

### Step 8 — Find the task's public IP and verify

```bash
aws ecs describe-services --cluster ecs-learning-cluster --services ecs-learning-app-service
```

Get the running task's ENI, then its public IP:

```bash
TASK_ARN=$(aws ecs list-tasks --cluster ecs-learning-cluster --service-name ecs-learning-app-service --query 'taskArns[0]' --output text)
ENI_ID=$(aws ecs describe-tasks --cluster ecs-learning-cluster --tasks "$TASK_ARN" \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text)
aws ec2 describe-network-interfaces --network-interface-ids "$ENI_ID" \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text
```

```bash
curl http://<task-public-ip>:3968/
curl http://<task-public-ip>:3968/api/info   # now shows real ECS task metadata
```

### Step 9 — Publish the frontend to S3

```bash
aws s3 mb s3://<your-unique-bucket-name> --region <your-region>

aws s3 website s3://<your-unique-bucket-name>/ --index-document index.html

# Allow public reads (needed for a public static site with no CloudFront in front)
aws s3api put-public-access-block --bucket <your-unique-bucket-name> \
  --public-access-block-configuration BlockPublicPolicy=false,RestrictPublicBuckets=false,BlockPublicAcls=false,IgnorePublicAcls=false

aws s3api put-bucket-policy --bucket <your-unique-bucket-name> --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::<your-unique-bucket-name>/*"
  }]
}'

aws s3 sync frontend/ s3://<your-unique-bucket-name>/
```

Your site is now at
`http://<your-unique-bucket-name>.s3-website-<your-region>.amazonaws.com`.
Open it, paste in `http://<task-public-ip>:3968` as the backend URL, and hit
the buttons — this is the real cross-origin request the `cors` middleware
exists for.

### Step 10 — Make a backend change and let CI redeploy it

Edit `backend/src/server.js`, commit, and push to `main`. The
`deploy-backend` workflow picks it up automatically, builds and pushes a new
image, and updates the service. Watch it run under the repo's **Actions**
tab. ECS itself performs a rolling deployment underneath: starts a new task,
waits for it to pass the health check, then drains and stops the old one —
which is why the app handles `SIGTERM` gracefully and exposes `/health`.
**Remember the task's public IP will change** — re-check it (Step 8) and
update the frontend's saved backend URL.

### Step 11 — Clean up (avoid ongoing charges)

```bash
aws ecs update-service --cluster ecs-learning-cluster --service ecs-learning-app-service --desired-count 0
aws ecs delete-service --cluster ecs-learning-cluster --service ecs-learning-app-service
aws ecs delete-cluster --cluster-name ecs-learning-cluster
aws ecr delete-repository --repository-name ecs-learning-app --force

aws s3 rm s3://<your-unique-bucket-name> --recursive
aws s3 rb s3://<your-unique-bucket-name>

aws iam delete-access-key --user-name github-actions-ecs-deployer --access-key-id <key-id>
aws iam delete-user-policy --user-name github-actions-ecs-deployer --policy-name ecs-deploy
aws iam delete-user --user-name github-actions-ecs-deployer
```

---

## 4. Things worth experimenting with next

- **Swap access keys for OIDC** — the workflow currently authenticates with
  long-lived `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` secrets. AWS's
  recommended pattern is an IAM OIDC identity provider + a role trusted only
  for this specific repo, so GitHub mints short-lived credentials per run
  and nothing long-lived sits in secrets at all.
- **Put an ALB back in front of the backend** — fixes the "IP changes every
  deploy" problem with a stable DNS name, and lets you scale past
  `desired-count: 1` without the frontend needing to know about multiple
  IPs.
- **Add CloudFront in front of the S3 bucket** — HTTPS, caching, and a
  custom domain for the frontend instead of the raw S3 website endpoint.
- **Autoscaling**: register the service as a scalable target with
  Application Auto Scaling.
- **Service discovery**: AWS Cloud Map, if you split the backend into
  multiple services later.
- **Secrets**: reference AWS Secrets Manager or SSM Parameter Store via the
  task definition's `secrets` field instead of plaintext `environment`.
- **Infrastructure as code**: once the manual flow makes sense, redo this in
  Terraform or AWS CDK so the whole stack is reproducible.

---

## 5. Files in this repo, at a glance

| File | Purpose |
|---|---|
| `backend/src/server.js` | The Express app (`/`, `/health`, `/api/info`), with CORS enabled |
| `backend/Dockerfile` | Builds the production container image |
| `backend/docker-compose.yml` | Run the container locally without touching AWS |
| `backend/ecs/task-definition.json` | The Fargate task definition — checked in with real values, image field gets overwritten by CI |
| `.github/workflows/deploy-backend.yml` | Builds, pushes to ECR, and redeploys the ECS service on every push to `backend/** ` on `main` |
| `frontend/index.html` | Static page — no build step — that calls the backend URL you give it |
