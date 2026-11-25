/**
 * Tests for the multiplayer relay stack: the TTL table, the WebSocket routes, the throttle, the
 * Lambda's runtime, and least-privilege IAM (no wildcards).
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { RealtimeStack } from "../lib/realtime-stack.ts";

// Reads the CloudFormation template CDK generates (this also bundles the relay with esbuild).
describe("RealtimeStack", () => {
  let template: Template;
  beforeAll(() => {
    const app = new App();
    const stack = new RealtimeStack(app, "SundoRealtime-test", {
      envName: "dev",
      env: { account: "111111111111", region: "ap-southeast-1" },
    });
    template = Template.fromStack(stack);
  });

  it("stores rooms in one on-demand table with a TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "sundo-live-dev",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("routes WebSocket messages by their action field", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routes.sort()).toEqual([
      "$connect",
      "$default",
      "$disconnect",
      "create_room",
      "input",
      "join_room",
      "snapshot",
    ]);
  });

  it("throttles the stage so a runaway client can't run up a bill", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 100,
        ThrottlingBurstLimit: 200,
      }),
    });
  });

  it("runs the relay on Node 24, ARM, with the table name and a short timeout", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Timeout: 5,
      Environment: { Variables: { TABLE_NAME: Match.anyValue() } },
    });
  });

  it("only lets the relay use its own table and post to its own API", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const statements = policies.flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
            };
          }
        ).Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    // DynamoDB data actions and execute-api:ManageConnections only; no wildcards like "dynamodb:*".
    expect(
      actions.every((a) => a.startsWith("dynamodb:") || a === "execute-api:ManageConnections"),
    ).toBe(true);
    expect(actions).not.toContain("dynamodb:*");
    expect(JSON.stringify(statements.map((s) => s.Resource))).not.toContain('"*"');
  });

  it("has nothing billed by the hour", () => {
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
