/**
 * Tests for the GitHub deploy stack's trust and permission policies. These two policies are the
 * whole security of keyless deploys, so every condition is pinned down exactly.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { GithubDeployStack } from "../lib/github-deploy-stack.ts";

// The security of keyless deploys lives in these two policies, so pin them down.
describe("GithubDeployStack", () => {
  let template: Template;
  beforeAll(() => {
    const app = new App();
    const stack = new GithubDeployStack(app, "SundoGithub-test", {
      repo: "ElleDiablo/sundo",
      oidcSubjectPrefix: "repo:ElleDiablo@100169794/sundo@1471471072",
      githubEnvironment: "dev",
      env: { account: "111111111111", region: "ap-southeast-1" },
    });
    template = Template.fromStack(stack);
  });

  it("trusts GitHub's OIDC issuer for the STS audience only", () => {
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
  });

  it("lets only this exact repo (by immutable ID) and its dev Environment assume the role", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub":
                  "repo:ElleDiablo@100169794/sundo@1471471072:environment:dev",
              },
            },
          }),
        ],
      },
    });
  });

  it("can only assume the CDK bootstrap roles, nothing else", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.Properties.PolicyDocument.Statement as {
      Action: string[];
      Resource: string[];
    }[];
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(["sts:AssumeRole", "sts:TagSession"]);
    expect(statements[0]?.Resource).toEqual([
      "arn:aws:iam::111111111111:role/cdk-hnb659fds-deploy-role-111111111111-ap-southeast-1",
      "arn:aws:iam::111111111111:role/cdk-hnb659fds-file-publishing-role-111111111111-ap-southeast-1",
      "arn:aws:iam::111111111111:role/cdk-hnb659fds-image-publishing-role-111111111111-ap-southeast-1",
      "arn:aws:iam::111111111111:role/cdk-hnb659fds-lookup-role-111111111111-ap-southeast-1",
    ]);
  });
});
