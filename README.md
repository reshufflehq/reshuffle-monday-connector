# reshuffle-monday-connector

[Code](https://github.com/reshufflehq/reshuffle-monday-connector) |
[npm](https://www.npmjs.com/package/reshuffle-monday-connector) |
[Code sample](https://github.com/reshufflehq/reshuffle-monday-connector/examples)

`npm install reshuffle-monday-connector`

### Reshuffle Monday Connector

This package contains a [Reshuffle](https://github.com/reshufflehq/reshuffle)
connector for connecting to [Monday](https://monday.com).

A full documentation of Monday's API is available [here](https://monday.com/developers/v2).

### Table of Contents

[Configuration Options](#configuration)

#### Connector Events

[Listening to Monday events](#listen)

#### Connector Actions
[Get Board](#getBoard) - Retrieve a board details object from Monday

[Get Board by name](#getBoardIdByName) - Lookup a board id from its name.

[Get Board Items](#getBoardItems) - Retrieve all items for a specific board.

[Get Group](#getGroup) - Retrieve a group details object from Monday

[Get Item](#getItem) - Retrieve an item details object from Monday

[Create Item](#createItem) - Create a new item in a board

[Update Item](#updateItem) - Update an item's name in a board

[Update Column Values](#updateColumnValues) - Update an item's column values

[Query](#query) - Run a GraphQL query

[SDK](#sdk) - Retrieve a full Monday sdk object


### <a name="configuration"></a>Configuration Options

To work with this connector, you'll need to get a token [from here](https://monday.com/developers/v2#authentication-section) :

1. Log into your monday.com account.
2. Click on your avatar (picture icon) in the bottom left corner.
3. Select Admin from the resulting menu (this requires you to have admin permissions).
4. Go to the API section.
5. Generate a “API v2 Token”
6. Copy your token.

```typescript
interface MondayConnectorConfigOptions {
  token: string
  baseURL?: string
  webhookPath?: string
}
```

### Connector events

#### <a name="listen"></a> Listening to Monday events

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

#### <a name="getBoard"></a> getBoard

Obtain details of a Monday board (or a list of boards). Use the Monday Board id as the parameter.
_Note: To obtain the board_id, visit your board in the browser and copy the id from the last part of the URL
e.g. if your board's url is https://my-company.monday.com/boards/123456789 - then your board id is 123456789

```typescript
const boardId = '123456789'
const board = await connector.getBoard(boardId)
```

#### <a name="getBoardIdByName"></a> getBoardIdByName

Find a board Id by its name

```typescript
const boardId = await connector.getBoardIdByName('My board')
```

#### <a name="getBoardItems"></a> getBoardItems

Get all the items in a board. The returned object has a `name` field with
the name of the board, and an `items` object, with item data accessible
by item Ids. Data for each item is an object including the item's `name` and
values for each column.

```typescript
const boardItems = await connector.getBoardItems(boardId)
```

#### <a name="getColumn"></a> getColumn

Query a column or a list of columns of a board by the board's Id

```typescript
const column = await connector.getColumn(boardId)
```

##### <a name="getGroup"></a> getGroup

Query a group or a list of groups
_Monday uses groups to group items together inside a board._


```typescript
const group = await connector.getGroup(groupId)
```

#### <a name="getItem"></a> getItem

Query an item or a list of items

```typescript
const item = await connector.getItem(itemId)
```

#### <a name="createItem"></a> createItem

Creates a new item and adds it to the specified board.

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| board_id      | Int    | Yes      |
| item_name     | String | Yes      |
| column_values | JSON   | No       |
| group_id      | String | No       |

Example of column_values

```typescript
const column_values = JSON.stringify({
  [column_id]: 'example data',
  [column_id2]: 'another example',
})
```

```typescript
const item = await connector.createItem(boardId, item_name, column_values, groupId)
```

#### <a name="updateItem"></a> updateItem

Update an item's name

```typescript
const item = await connector.updateItem(boardId, groupId, 'Updated Item Name')
```

#### <a name="updateColumnValues"></a> updateColumnValues

Update an specific item in a specific board with new values. The `updaters`
object should include one update function for each column that needs to be
updated, with property names being the titles for these columns. Each
function receives the old value and should return the new value for that
column.

```typescript
await updateColumnValues(myBoardId, myItemId, {
  Name: (name: string) => name.toUpperCase,
  Phone: (phone: string) => phone.startsWith('+') ? phone : `+${phone}`,
})
```

#### createWebhook

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

#### <a name="query"></a> query

Run any GraphQL query

```typescript
const res = await connector.query('query { users { name } }')
```

#### <a name="sdk"></a> sdk

Returns an object providing full access to the Monday GraphQL API

```typescript
const sdk = await connector.sdk()
```
