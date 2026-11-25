/**
 * The real RoomStore: DynamoDB through the AWS SDK's "document client" (plain JS objects in and
 * out, instead of DynamoDB's typed { S: "..." } format).
 */
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Item, RoomStore } from "./rooms.ts";

export class DynamoRoomStore implements RoomStore {
  private readonly db: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(table: string, client = new DynamoDBClient({})) {
    this.table = table;
    this.db = DynamoDBDocumentClient.from(client);
  }

  async putAllIfNew(items: readonly Item[], mustBeNew: Item): Promise<boolean> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          // One transaction: either every item is written, or none is.
          TransactItems: items.map((item) => ({
            Put: {
              TableName: this.table,
              Item: item,
              // Only the "must be new" item gets the check: fail if those keys already exist.
              ...(item.PK === mustBeNew.PK && item.SK === mustBeNew.SK
                ? { ConditionExpression: "attribute_not_exists(PK)" }
                : {}),
            },
          })),
        }),
      );
      return true;
    } catch (error) {
      // The condition failed (the code is taken): tell the caller to try another code.
      if (error instanceof TransactionCanceledException) {
        const taken = error.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed");
        if (taken) return false;
      }
      throw error;
    }
  }
}
