/**
 * ParseProvider factory — pick a backend from env.
 *
 * `docker` is the OSS default (talks to the sidecar `koji-parse`
 * container). `modal` routes to a Modal-hosted Docling service for the
 * hosted-cloud tier — see `modal.ts` for the env vars it reads.
 */

import type { ParseProvider } from "./provider";
import { DockerParseProvider } from "./docker";
import { ModalParseProvider } from "./modal";

export function createParseProvider(): ParseProvider {
  const backend = process.env.KOJI_PARSE_BACKEND ?? "docker";
  switch (backend) {
    case "docker":
      return new DockerParseProvider();
    case "modal":
      return new ModalParseProvider();
    default:
      throw new Error(`Unknown KOJI_PARSE_BACKEND: ${backend}`);
  }
}
