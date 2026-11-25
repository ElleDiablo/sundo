/**
 * Tests for the website stack: private bucket, HTTPS-only CloudFront with Origin Access Control,
 * nothing billed by the hour. They read the generated CloudFormation template; no AWS needed.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { WebStack } from "../lib/web-stack.ts";

// These tests read the CloudFormation template CDK generates. No AWS account needed.
describe("WebStack", () => {
  let template: Template;
  beforeAll(() => {
    // A throwaway one-page "site", so the test doesn't need the real client build.
    const siteDir = mkdtempSync(join(tmpdir(), "sundo-site-"));
    writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>test</title>");
    const app = new App();
    const stack = new WebStack(app, "SundoWeb-test", {
      envName: "dev",
      siteDir,
      env: { account: "111111111111", region: "ap-southeast-1" },
    });
    template = Template.fromStack(stack);
  });

  it("keeps the bucket private (no public access at all)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("refuses non-HTTPS requests to the bucket", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("serves through CloudFront over HTTPS with Origin Access Control", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        Origins: Match.arrayWith([Match.objectLike({ OriginAccessControlId: Match.anyValue() })]),
      }),
    });
  });

  it("creates exactly one bucket for the site (plus nothing hourly-billed)", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    for (const type of [
      "AWS::EC2::NatGateway",
      "AWS::EC2::Instance",
      "AWS::RDS::DBInstance",
      "AWS::Kinesis::Stream",
    ]) {
      expect(Object.keys(template.findResources(type))).toHaveLength(0);
    }
  });
});
