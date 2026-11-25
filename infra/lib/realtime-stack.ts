import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

export interface RealtimeStackProps extends StackProps {
  envName: string;
}

/**
 * Multiplayer relay (ADR-0001): the host's browser runs the game; this only passes messages.
 *
 * Browser ══WebSocket══► API Gateway ──► Lambda "relay" ──► DynamoDB "sundo-live" (rooms)
 *                                            └── postToConnection ──► replies to browsers
 *
 * Everything here is billed per use (messages, invocations, reads/writes), so it costs nothing
 * while nobody is playing.
 */
export class RealtimeStack extends Stack {
  readonly url: string;

  constructor(scope: Construct, id: string, props: RealtimeStackProps) {
    super(scope, id, props);
    const isProd = props.envName === "prod";

    // One table for rooms and connections (architecture §5). TTL deletes old rooms by itself.
    const table = new dynamodb.TableV2(this, "Live", {
      tableName: `sundo-live-${props.envName}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(), // pay per request, nothing while idle
      timeToLiveAttribute: "ttl",
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // The relay: one small function for every route. esbuild bundles packages/server into one file.
    const relay = new NodejsFunction(this, "Relay", {
      entry: fileURLToPath(new URL("../../packages/server/src/handler.ts", import.meta.url)),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // Graviton: cheaper per millisecond
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: table.tableName },
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, "RelayLogs", {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // Least privilege: read/write this one table, nothing else.
    table.grantReadWriteData(relay);

    const integration = (name: string) => new WebSocketLambdaIntegration(name, relay);
    const api = new apigw.WebSocketApi(this, "Api", {
      apiName: `sundo-${props.envName}`,
      // Route by the "action" field of each JSON message, e.g. {"action":"create_room"}.
      routeSelectionExpression: "$request.body.action",
      connectRouteOptions: { integration: integration("Connect") },
      disconnectRouteOptions: { integration: integration("Disconnect") },
      defaultRouteOptions: { integration: integration("Fallback") }, // not "Default": CDK drops that id from names
    });
    api.addRoute("create_room", { integration: integration("CreateRoom") });

    const stage = new apigw.WebSocketStage(this, "Stage", {
      webSocketApi: api,
      stageName: props.envName,
      autoDeploy: true,
      // Caps how many messages per second the whole API accepts, so a runaway client
      // can't run up a bill. A 4-player room sends about 30 messages/s.
      throttle: { rateLimit: 100, burstLimit: 200 },
    });
    // Let the relay send replies to connected browsers (postToConnection), on this API only.
    api.grantManageConnections(relay);

    this.url = stage.url;
    new CfnOutput(this, "WebSocketUrl", { value: stage.url });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
