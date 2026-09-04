# ECS-Project

A small app for learning how to deploy containers to AWS, split the way a
real (if tiny) app would be:

- **`backend/`** — a Node.js/Express API, containerized and deployed to
  **AWS ECS (Fargate)**.
- **`frontend/`** — a plain static HTML/JS page, deployed to **S3** static
  website hosting, that calls the backend directly (no load balancer — the
  browser hits the ECS task's public IP).

Backend deploys run via GitHub Actions
(`.github/workflows/deploy-backend.yml`) — push to `main` and it builds,
pushes to ECR, and redeploys the ECS service automatically.

## Quick start (local)

```bash
cd backend
npm install
npm start
# or: docker compose up --build
```

Visit `http://localhost:3968`, `/health`, and `/api/info`.

Then open `frontend/index.html` directly in a browser, paste
`http://localhost:3968` into the "Backend URL" field, and click one of the
request buttons.

## Learn ECS + S3 with this repo

See [LEARNING.md](./LEARNING.md) for core ECS concepts and a full
step-by-step walkthrough: setting up the GitHub Actions deploy user, running
the backend as an ECS Fargate service with a public IP, and publishing the
frontend to S3.
