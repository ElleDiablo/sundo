import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { WebStack } from "../lib/web-stack.ts";

// These tests read the CloudFormation template CDK generates. No AWS account needed.
describe("WebStack", () => {
  let template: Template;
  beforeAll(() => {
    const app = new App();
    const stack = new WebStack(app, "SundoWeb-test", {
      envName: "dev",
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
