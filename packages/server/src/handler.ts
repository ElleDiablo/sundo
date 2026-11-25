/**
 * Lambda entry point for the WebSocket relay. Wires the real AWS pieces into relay.ts.
 *
 * Environment (set by the SundoRealtime stack):
 *   TABLE_NAME   the sundo-live table
 * The address for replying to browsers comes from each event (domain + stage), so it isn't configured.
 */
import { randomInt } from "node:crypto";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { CachedStore } from "./cachedStore.ts";
import { DynamoRoomStore } from "./dynamo.ts";
import { handleRoute, type RelayResult, type Sender } from "./relay.ts";

const tableName = process.env["TABLE_NAME"];
if (!tableName) throw new Error("TABLE_NAME is not set");
// Created once per Lambda container and reused by later calls (faster warm starts). The cache in
// front of DynamoDB remembers lookups that never change (cachedStore.ts), saving ~20 ms per input.
const store = new CachedStore(new DynamoRoomStore(tableName), Date.now);
const senders = new Map<string, Sender>();

/** A Sender for the API that sent this event. */
function senderFor(event: APIGatewayProxyWebsocketEventV2): Sender {
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  let sender = senders.get(endpoint);
  if (!sender) {
    const api = new ApiGatewayManagementApiClient({ endpoint });
    sender = {
      async send(connectionId, message) {
        await api.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(message),
          }),
        );
      },
    };
    senders.set(endpoint, sender);
  }
  return sender;
}

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<RelayResult> {
  const { routeKey, connectionId } = event.requestContext;
  return handleRoute(routeKey, connectionId, event.body, {
    // console output goes to CloudWatch Logs (the relay's log group, kept two weeks).
    log: (message) => console.warn(message),
    store,
    sender: senderFor(event),
    now: Date.now,
    // Room codes use a cryptographically random source, so they can't be predicted.
    random: () => randomInt(0, 1_000_000) / 1_000_000,
  });
}
