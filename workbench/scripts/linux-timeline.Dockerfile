# Qualification environment only; does not build ZooGlass or run tests.
FROM eclipse-temurin:25-jdk-jammy@sha256:5ba254809ef542504d40d47271c7d6c4f240fe40ca1386259806d431f13b6b4f AS java
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
ENV TZ=UTC
WORKDIR /workspace/workbench
