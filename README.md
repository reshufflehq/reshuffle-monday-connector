# reshuffle-monday-connector

### Reshuffle Monday Connector

This connector provides a connector for [Monday](https://monday.com).

To get a token ([From here](https://monday.com/developers/v2#authentication-section)):

1. Log into your monday.com account.
2. Click on your avatar (picture icon) in the bottom left corner.
3. Select Admin from the resulting menu (this requires you to have admin permissions).
4. Go to the API section.
5. Generate a “API v2 Token”
6. Copy your token.

#### Configuration Options:

```typescript
interface MondayConnectorConfigOptions {
  token: string
  baseURL?: string
  webhookPath?: string
}
```

#### Connector events

##### listening to Monday events

To listen to events happening in Monday, create an event handler with the
boardId, event type optional column id:

```typescript
interface MondayConnectorEventOptions {
  boardId: string | number
  type:
    | 'IncomingNotification'
    | 'ChangeColumnValue'
    | 'ChangeSpecificColumnValue'
    | 'CreateItem'
    | 'CreateUpdate'
  columnId?: string // for type === ChangeSpecificColumnValue
}
```

Events require that an integration webhook be configured in Monday. The
connector does not configure integrations automatically becuase at the
moment it has no way of tracking which integrations are already configured
in Monday. You can either configure an integration through the Monday UI or
call `createEventWebhook`.

#### Connector actions

##### getBoard

Query a board or a list of boards

```typescript
// To get the board_id, visit your board in the browser and copy the id from the last part of the URL e.g. 123456789 from https://my-company.monday.com/boards/123456789
const board = await connector.getBoard(BOARD_ID)
```

##### getBoardIdByName

Find a board ID by its name

```typescript
const boardId = await connector.getBoardIdByName('My board')
```

##### getBoardItems

Get all the items in a board. The returned object has a `name` field with
the name of the board, and an `items` object, whose with item data accessible
by item IDs. Data for each item is an object including the item's `name` and
values for each column.

```typescript
const boardItems = await connector.getBoardItems(boardId)
```

##### getColumn

Query a column or a list of columns

```typescript
const column = await connector.getColumn(BOARD_ID)
```

##### getGroup

Query a group or a list of groups

```typescript
const group = await connector.getGroup(GROUP_ID)
```

##### getItem

Query an item or a list of items

```typescript
const item = await connector.getItem(ITEM_ID)
```

##### createItem

Creates a new item to the board.

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| board_id      | Int    | Yes      |
| item_name     | String | Yes      |
| column_values | JSON   | No       |
| group_id      | String | No       |

Example of column_values

```typescript
const column_values = JSON.stringify({
  [COLUMN_ID]: 'example data',
  [COLUMN_ID2]: 'another example',
})
```

```typescript
const item = await connector.createItem(BOARD_ID, item_name, column_values, group_id)
```

##### updateItem

Update an item

```typescript
const item = await connector.updateItem(ITEM_ID, 'my updated item')
```

##### updateColumnValues

Update an specific item in a specific board with new values. The `updaters`
object should include one update function for each column that needs to be
updated, with property names being the titles for these columns. Each
functions receive the old value and should return the new value for that
column.

```typescript
await updateColumnValues(myBoardId, myItemId, {
  Name: (name: string) => name.toUpperCase,
  Phone: (phone: string) => phone.startsWith('+') ? phone : `+${phone}`,
})
```

##### createWebhook

Create a webhook. Note - using when you create an `on` handler the event will be created for you if you dont pass a webhookId

```typescript
const webhookId = await connector.createWebhook(
  BOARD_ID,
  'https://example.com/monday-webhook',
  'create_item',
)
```

##### createEventWebhook

Create a webhook for an event. This action requires that the connector be
configured with a `baseURL`.

```typescript
const webhookId = await connector.createEventWebhook(
  BOARD_ID,
  'ChangeColumnValue'
)
```

##### deleteWebhook

Delete a webhook

```typescript
const deletedWebhook = await connector.deleteWebhook(WEBHOOK_ID)
```

##### query

Run any GraphQL query

```typescript
const res = await connector.query('query { users { name } }')
```

##### sdk

Full access to the Monday GraphQL API

```typescript
const sdk = await connector.sdk()
```
