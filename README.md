# ECS-Project

A tiny Node.js/Express app for learning how to deploy containers to AWS ECS (Fargate).

## Quick start

```bash
npm install
npm start
# or
docker compose up --build
```

Then visit `http://localhost:3000`, `/health`, and `/api/info`.

## Learn ECS with this repo

See [LEARNING.md](./LEARNING.md) for ECS concepts and a full step-by-step
walkthrough (ECR, cluster, task definition, service, ALB) using the files in
`ecs/`.
