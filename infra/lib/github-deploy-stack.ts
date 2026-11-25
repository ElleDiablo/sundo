import { CfnOutput, DefaultStackSynthesizer, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubDeployStackProps extends StackProps {
  /** GitHub repository allowed to deploy, as `owner/name` (used in descriptions only). */
  repo: string;
  /**
   * The repo as GitHub writes it in OIDC tokens. GitHub's immutable format adds the owner's and
   * repo's numeric IDs (`repo:owner@ownerId/name@repoId`), so a deleted-and-recreated repo with the
   * same name can't match. Check with: gh api repos/<owner>/<name>/actions/oidc/customization/sub
   */
  oidcSubjectPrefix: string;
  /** GitHub Environment the deploy job runs in; only that job can assume the role. */
  githubEnvironment: string;
}

/**
 * Lets GitHub Actions deploy without stored AWS keys (ADR-0007).
 *
 * GitHub job ──OIDC token──► STS ──1-hour credentials──► this role ──AssumeRole──► CDK bootstrap roles
 *
 * Deployed by hand, never by CI, so a workflow can't widen its own access.
 */
export class GithubDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    // Tells IAM to trust tokens signed by GitHub Actions. One per account.
    const provider = new iam.OidcProviderNative(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    // Only a job in this repo AND this GitHub Environment can get credentials.
    // The Environment only allows the protected `main` branch, so PRs and forks can't deploy.
    const role = new iam.Role(this, "DeployRole", {
      roleName: `sundo-github-deploy-${props.githubEnvironment}`,
      description: `GitHub Actions deploys from ${props.repo} (environment: ${props.githubEnvironment})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `${props.oidcSubjectPrefix}:environment:${props.githubEnvironment}`,
        },
      }),
    });

    // The role itself can do nothing except step into the CDK bootstrap roles
    // (deploy, upload assets, look up context) that `cdk bootstrap` created.
    const q = DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: ["deploy", "file-publishing", "image-publishing", "lookup"].map(
          (kind) =>
            `arn:aws:iam::${this.account}:role/cdk-${q}-${kind}-role-${this.account}-${this.region}`,
        ),
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn });
  }
}
