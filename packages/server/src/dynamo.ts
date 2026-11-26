/**
 * The real RoomStore: DynamoDB through the AWS SDK's "document client" (plain JS objects in and
 * out, instead of DynamoDB's typed { S: "..." } format).
 *
 * Transactions map one-to-one onto DynamoDB's TransactWriteItems: up to 100 steps, all applied or
 * none. When a condition fails, DynamoDB cancels the whole transaction and reports a reason per
 * step, which is turned into the list of failed step indexes the room logic expects.
 */
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Item, Key, RoomStore, TransactResult, WriteOp } from "./rooms.ts";

export class DynamoRoomStore implements RoomStore {
  private readonly db: DynamoDBDocumentClient;
  private readonly table: string;

  /** `client` can be swapped in tests; by default it uses the Lambda's own AWS credentials. */
  constructor(table: string, client = new DynamoDBClient({})) {
    this.table = table;
    this.db = DynamoDBDocumentClient.from(client);
  }

  async get(key: Key): Promise<Item | undefined> {
    // Strongly consistent: a room created a moment ago must be visible to someone joining it.
    const res = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: key.PK, SK: key.SK },
        ConsistentRead: true,
      }),
    );
    return res.Item as Item | undefined;
  }

  async query(pk: string, skPrefix: string): Promise<Item[]> {
    // A Query reads one partition (one PK), optionally narrowed by the start of the sort key.
    // That's why seats are "SEAT#0"…"SEAT#3": begins_with(SK, "SEAT#") finds them all in one call.
    // Eventually consistent (the default) costs half a strongly consistent read; a guest who joined
    // a fraction of a second ago may miss one snapshot, and the next one 100 ms later reaches them.
    // A room has at most 4 seats, far below the 1 MB page size, so there's no paging to handle.
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": skPrefix },
      }),
    );
    return (res.Items ?? []) as Item[];
  }

  async transact(ops: readonly WriteOp[]): Promise<TransactResult> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: ops.map((op) => this.toTransactItem(op)),
        }),
      );
      return { ok: true };
    } catch (error) {
      // DynamoDB gives one reason per step, in order; "ConditionalCheckFailed" marks the steps whose
      // condition didn't hold. Anything else (throttling, a bug) is a real error and is rethrown.
      if (error instanceof TransactionCanceledException && error.CancellationReasons) {
        const failed = error.CancellationReasons.flatMap((r, i) =>
          r.Code === "ConditionalCheckFailed" ? [i] : [],
        );
        if (failed.length > 0) return { ok: false, failed };
      }
      throw error;
    }
  }

  /** One step of our transaction in DynamoDB's shape. */
  private toTransactItem(op: WriteOp) {
    const TableName = this.table;
    switch (op.kind) {
      case "mustExist":
        // A ConditionCheck writes nothing; it only makes the transaction fail if the item is missing.
        return {
          ConditionCheck: {
            TableName,
            Key: { PK: op.key.PK, SK: op.key.SK },
            ConditionExpression: "attribute_exists(PK)",
          },
        };
      case "put":
        return {
          Put: {
            TableName,
            Item: op.item,
            // "Only if new": fail if an item with these keys is already there.
            ...(op.onlyIfNew ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
          },
        };
      case "delete":
        return {
          Delete: {
            TableName,
            Key: { PK: op.key.PK, SK: op.key.SK },
            // Only delete it if it still belongs to this connection.
            ...(op.onlyIfConnId !== undefined
              ? {
                  ConditionExpression: "connId = :connId",
                  ExpressionAttributeValues: { ":connId": op.onlyIfConnId },
                }
              : {}),
          },
        };
    }
  }
}
