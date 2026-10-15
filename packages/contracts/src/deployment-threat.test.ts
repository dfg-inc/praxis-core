import { afterEach, describe, expect, it } from "vitest";
import { assessDeploymentThreats, assertSecureDeployment } from "./broker.js";

describe("deployment threat assessment", () => {
  const previous = {
    mode: process.env.PRAXIS_SECURITY_MODE,
    model: process.env.PRAXIS_DEPLOYMENT_MODEL,
    allow: process.env.PRAXIS_ALLOW_DOCKER_SOCKET,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries({
      PRAXIS_SECURITY_MODE: previous.mode,
      PRAXIS_DEPLOYMENT_MODEL: previous.model,
      PRAXIS_ALLOW_DOCKER_SOCKET: previous.allow,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("blocks docker-uid secure mode when the docker socket is readable", () => {
    process.env.PRAXIS_SECURITY_MODE = "secure";
    process.env.PRAXIS_DEPLOYMENT_MODEL = "docker-uid";
    delete process.env.PRAXIS_ALLOW_DOCKER_SOCKET;
    const assessment = assessDeploymentThreats({
      dockerSockets: ["/var/run/docker.sock", `${process.env.HOME}/.docker/run/docker.sock`],
    });
    if (assessment.dockerSocketAccessible) {
      expect(assessment.blocking.some((item) => /Docker control socket/.test(item))).toBe(true);
      expect(() => assertSecureDeployment()).toThrow(/Docker control socket|isolation/i);
    } else {
      expect(assessment.blocking.some((item) => /Docker control socket/.test(item))).toBe(false);
    }
  });

  it("does not block when docker-uid model is unset", () => {
    process.env.PRAXIS_SECURITY_MODE = "secure";
    delete process.env.PRAXIS_DEPLOYMENT_MODEL;
    const assessment = assessDeploymentThreats({ dockerSockets: ["/var/run/docker.sock"] });
    expect(assessment.blocking.some((item) => /Docker control socket/.test(item))).toBe(false);
  });
});
