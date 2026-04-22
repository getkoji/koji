---
title: AWS Bedrock
description: Run Koji extractions against Claude, Titan, or Llama models hosted in AWS Bedrock.
---

# AWS Bedrock

For buyers already on AWS who'd rather procure inference through a Bedrock line-item than onboard another vendor. Works for Anthropic Claude, Amazon Titan, Meta Llama, Mistral, and Cohere models — whichever ones your account has been granted access to.

Koji calls Bedrock through the **Converse** API (`POST /model/{modelId}/converse`) via SigV4-signed requests. One adapter covers every vendor-qualified model ID, so switching between Claude and Titan is just a model-string change.

## 1. Enable Bedrock + request model access

This is the step that trips up new users. Bedrock is an opt-in service, and the models you actually want (Claude, Llama) require **per-account activation**.

1. In the AWS console, open **Bedrock** in the region you plan to use (see [region routing](#region-routing) below).
2. **Model access → Manage model access.**
3. Tick the models you want. Anthropic and third-party models take a few minutes to a few hours to approve. Amazon's own models (Titan, Nova) are instant.
4. Wait for *Access granted* — calls will 403 until this clears.

## 2. Create an IAM user with minimal permissions

Don't use root credentials. Don't use `Action: "bedrock:*"` or `Resource: "*"`. The minimum policy Koji needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:Converse"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-text-premier-v1:0"
      ]
    }
  ]
}
```

Add one ARN per model you'll use. Scoping to specific ARNs (not `*`) means a leaked key can't be used to run up a bill on models you didn't intend to expose.

Attach the policy to a new IAM user, then create an **access key** for that user. Store the key ID + secret somewhere you won't lose them — AWS only shows the secret once.

### Temporary credentials

For production deployments, prefer short-lived STS credentials over long-lived access keys: assume a role, pass the three values (`AccessKeyId`, `SecretAccessKey`, `SessionToken`) into Koji, and rotate on a schedule. Koji accepts all three and passes the `SessionToken` through to SigV4 signing.

## 3. Enter the credentials in Koji

**Settings → Model Providers → Add provider.**

| Field | Value |
|-------|-------|
| Name | e.g. `bedrock-useast1` |
| Provider | `AWS Bedrock` |
| AWS region | `us-east-1` (or whichever region — see below) |
| Access key ID | `AKIA...` |
| Secret access key | The secret paired with the key ID |
| Session token | Only if using STS temporary credentials; otherwise leave blank |
| Default model | The full Bedrock model ID — see cheat sheet below |

## 4. Model ID cheat sheet

Bedrock model IDs are vendor-qualified and include a version suffix. Partial list — check **Bedrock → Foundation models** in your region for the authoritative list:

| Family | Example model ID |
|--------|------------------|
| Anthropic Claude Sonnet 3.5 | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Anthropic Claude Haiku 3.5 | `anthropic.claude-3-5-haiku-20241022-v1:0` |
| Amazon Titan Text Premier | `amazon.titan-text-premier-v1:0` |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` |
| Meta Llama 3.1 70B Instruct | `meta.llama3-1-70b-instruct-v1:0` |
| Mistral Large | `mistral.mistral-large-2407-v1:0` |
| Cohere Command R+ | `cohere.command-r-plus-v1:0` |

Model IDs are case-sensitive. Typos return 400 (not 404), so watch for them in extraction traces.

## Region routing

The region you configure on the provider determines which Bedrock data-plane Koji calls — i.e. `bedrock-runtime.us-east-1.amazonaws.com` vs `bedrock-runtime.eu-central-1.amazonaws.com`. Models are *not* globally available; a given model ID only works in regions AWS has enabled it in.

Rough guidance as of 2026-Q2 (verify on the AWS regional availability page before committing):

- **us-east-1 (N. Virginia)** — broadest catalog, including Anthropic's latest Claude snapshots and Amazon Nova.
- **us-west-2 (Oregon)** — second-broadest, often has Claude and Llama in parallel with us-east-1.
- **eu-central-1 (Frankfurt), eu-west-3 (Paris)** — for EU residency; narrower catalog, sometimes one model version behind.
- **ap-northeast-1 (Tokyo), ap-southeast-2 (Sydney)** — Claude available, Titan available, Llama spotty.

If you need the same logical "claude-sonnet-3.5" model in multiple regions, you typically need one Koji provider per region — the model IDs are the same, but the IAM ARN's region segment differs.

## Cost notes

Bedrock bills at Amazon's per-model rates, which are typically 5–20% higher than calling the upstream vendor directly (OpenAI, Anthropic) for the equivalent model. The premium is the price of single-cloud procurement — one bill, one DPA, one set of credentials. If margins matter more than procurement simplicity, use the [direct vendor path](openai.md).

Check [aws.amazon.com/bedrock/pricing](https://aws.amazon.com/bedrock/pricing) for current per-token rates per model per region.

## Known limitation: no tool use yet

The Bedrock Converse API supports tool use via a separate `toolConfig` shape (tool specs + tool-use / tool-result content blocks), distinct from both OpenAI's `tools` array and Anthropic's native `tool_use` blocks. Koji's Bedrock adapter does **not** wire tool use yet — schemas that rely on tool-call-style field extraction will raise `NotImplementedError` on a Bedrock endpoint.

If you need tool use against Bedrock-hosted Claude today, the workaround is to call Bedrock through an OpenAI-compatible proxy (LiteLLM, Portkey, AWS Bedrock Access Gateway) and configure Koji with `provider: OpenAI` pointing at the proxy.

Native Bedrock tool-use is tracked on the internal roadmap.

## See also

- [Anthropic direct](anthropic.md) — cheaper path to Claude if you don't need AWS procurement
- [OpenAI](openai.md) — non-AWS alternative
- Provider adapter source: `services/extract/providers.py` (`BedrockProvider`)
- Provider UI: `dashboard/src/app/(app)/t/[tenantSlug]/projects/[projectSlug]/settings/model-providers/page.tsx`
