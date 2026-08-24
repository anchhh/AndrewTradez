# Build context is the repo root (see render.yaml's dockerContext).

FROM node:20-slim AS frontend-build
WORKDIR /build/frontend
COPY admin-app/frontend/package*.json ./
RUN npm install
COPY admin-app/frontend/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app/backend
COPY admin-app/backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY admin-app/backend/ ./
COPY --from=frontend-build /build/frontend/dist /app/frontend/dist

ENV PORT=5050
EXPOSE 5050
CMD gunicorn -w 2 -b 0.0.0.0:$PORT app:app
