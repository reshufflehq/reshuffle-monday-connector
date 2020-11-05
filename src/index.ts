import { Reshuffle, BaseHttpConnector, EventConfiguration } from 'reshuffle-base-connector'
import { Request, Response, NextFunction } from 'express'
import mondaySdk from 'monday-sdk-js'

const DEFAULT_WEBHOOK_PATH = '/monday-event'

export interface MondayConnectorConfigOptions {
  token: string
}

export interface MondayConnectorEventOptions {
  boardId: number
  baseUrl: string
  type:
    | 'incoming_notification'
    | 'change_column_value'
    | 'change_specific_column_value'
    | 'create_item'
    | 'create_update'
  config?: Record<string, unknown>
  path?: string
  webhookId?: string
  deleteWebhookOnExit?: boolean
}

interface MondayApiReponse {
  data?: Record<string, any>
  errors?: Record<string, any>[]
  account_id?: string
}

interface MondaySdk extends ReturnType<typeof mondaySdk> {
  api(
    query: string,
    options?: { token?: string; variables?: Record<string, unknown> },
  ): Promise<MondayApiReponse>
}

const GET_BOARD_QUERY = `#graphql
query ($board_ids: [Int]!) {
  boards(ids: $board_ids) {
    name
    state
    board_folder_id
    owner {
      id
    }
    groups {
      id
    }
    items {
      id
    }
  }
}`

const GET_COLUMNS_QUERY = `#graphql
query ($board_ids: [Int]!) {
  boards (ids: $board_ids) {
    owner {
      id
    }
    columns {
      id
      title
      type
    }
  }
}`

const GET_GROUPS_QUERY = `#graphql
query ($board_ids: [Int]!, $group_ids: [String]) {
  boards (ids: $board_ids) {
    groups (ids: $group_ids) {
      title
      color
      position
    }
  }
}`

const GET_ITEMS_QUERY = `#graphql
query ($item_ids: [Int]!) {
  items (ids: $item_ids) {
    name
  }
}`

const CREATE_ITEM_QUERY = `#graphql
mutation ($board_id: Int!, $group_id: String, $item_name: String, $column_values: JSON!) {
  create_item (board_id: $board_id, group_id: $group_id, item_name: $item_name, column_values: $column_values) {
    id
  }
}`

const UPDATE_ITEM_QUERY = `#graphql
mutation($item_id: Int!, $body: String!) {
  create_update (item_id: $item_id, body: $body) {
    id
  }
}`

const CREATE_WEBHOOK_QUERY = `#graphql
mutation($board_id: Int!, $url: String!, $event: WebhookEventType!, $config: JSON) {
  create_webhook ( board_id: $board_id, url: $url, event: $event, config: $config ) {
  id
    board_id
  }
}`

const DELETE_WEBHOOK_QUERY = `#graphql
mutation($id: Int!) {
  delete_webhook ( id: $id ) {
    id
    board_id
  }
}`

export class MondayError extends Error {
  constructor(public errors?: any[]) {
    super(`Monday API Error (${errors ? errors.length : 'unknown'})`)
  }
}

export default class MondayConnector extends BaseHttpConnector<
  MondayConnectorConfigOptions,
  MondayConnectorEventOptions
> {
  _sdk: MondaySdk

  constructor(app: Reshuffle, options: MondayConnectorConfigOptions, id?: string) {
    super(app, options, id)
    this._sdk = mondaySdk({ token: options.token })
  }

  on(
    options: MondayConnectorEventOptions,
    handler: ({ req, res, next }: { req: Request; res: Response; next: NextFunction }) => void,
    eventId: string,
  ): EventConfiguration {
    if (!eventId) {
      eventId = `Monday${options.path}/${this.id}`
    }
    const event = new EventConfiguration(eventId, this, options)
    event.options.path = event.options.path || DEFAULT_WEBHOOK_PATH
    event.options.deleteWebhookOnExit = event.options.deleteWebhookOnExit || true
    this.eventConfigurations[event.id] = event

    this.app.when(event, handler as any)
    this.app.registerHTTPDelegate(event.options.path, this)

    if (!event.options.webhookId) {
      this.createWebhook(
        event.options.boardId,
        event.options.baseUrl + event.options.path,
        event.options.eventType,
        event.options.config,
      ).then((x) => {
        if (x?.create_webhook) {
          event.options.webhookId = Number(x.create_webhook.id)
        }
      })
    }

    return event
  }

  async handle(req: Request, res: Response, next: NextFunction): Promise<boolean> {
    const { method, path } = req
    let handled = false

    const eventConfiguration = Object.values(this.eventConfigurations).find(
      ({ options }) => options.path === path,
    )

    if (eventConfiguration) {
      if (req.body.challenge) {
        this.app.getLogger().info('Handling Monday web hook challenge')
        res.json({ challenge: req.body.challenge })
        handled = true
      } else {
        this.app.getLogger().info('Handling Monday event')
        handled = await this.app.handleEvent(eventConfiguration.id, {
          ...eventConfiguration,
          req,
          res,
        })
      }
    } else {
      this.app.getLogger().warn(`No Monday event configuration matching ${method} ${path}`)
    }

    next()

    return handled
  }

  async query(qs: string, variables?: Record<string, any>): Promise<MondayApiReponse['data']> {
    const res = await this._sdk.api(qs, variables ? { variables } : undefined)
    if ('data' in res) {
      return res.data
    }
    throw new MondayError(res.errors)
  }

  columnValuesToObject(columnValues: { title: string; value: string }[]): Record<string, any> {
    const obj: Record<string, any> = {}
    for (const cv of columnValues) {
      obj[cv.title] = JSON.parse(cv.value)
    }
    return obj
  }

  getBoard(boardIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this.query(GET_BOARD_QUERY, { board_ids: boardIds })
  }

  async getBoardIdByName(name: string): Promise<number> {
    const res = await this.query('query { boards { id name } }')
    const board = res?.boards.filter((b) => b.name === name)[0]
    return board && parseInt(board.id, 10)
  }

  async getBoardItems(
    boardId: string | number,
  ): Promise<
    | {
        name: any
        items: any
      }
    | undefined
  > {
    const res = await this.query(`
      query {
        boards (ids: ${boardId}) {
          name
          items {
            id
            name
            column_values {
              title
              value
            }
          }
        }
      }
    `)
    const board = res?.boards[0]
    const items = {}
    for (const item of board.items) {
      items[item.id] = this.columnValuesToObject(item.column_values)
      items[item.id].name = item.name
    }
    return { name: board.name, items }
  }

  getColumn(boardIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this.query(GET_COLUMNS_QUERY, { board_ids: boardIds })
  }

  getGroup(
    boardIds: number | number[],
    groupIds: string | string[],
  ): Promise<MondayApiReponse['data']> {
    return this.query(GET_GROUPS_QUERY, {
      board_ids: boardIds,
      group_ids: groupIds,
    })
  }

  getItem(itemIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this.query(GET_ITEMS_QUERY, { item_ids: itemIds })
  }

  createItem(
    boardId: number,
    itemName?: string,
    columnValues?: JSON,
    groupId?: string,
  ): Promise<MondayApiReponse['data']> {
    return this.query(CREATE_ITEM_QUERY, {
      board_id: boardId,
      group_id: groupId,
      item_name: itemName,
      column_values: columnValues
    })
  }

  updateItem(
    boardId: number,
    groupId: string,
    itemName: string,
  ): Promise<MondayApiReponse['data']> {
    return this.query(UPDATE_ITEM_QUERY, {
      board_id: boardId,
      group_id: groupId,
      item_name: itemName,
    })
  }

  createWebhook(
    boardId: number,
    url: string,
    event: string,
    config?: Record<string, unknown>,
  ): Promise<MondayApiReponse['data']> {
    return this.query(CREATE_WEBHOOK_QUERY, {
      board_id: boardId,
      url,
      event,
      config,
    })
  }

  deleteWebhook(id: number): Promise<MondayApiReponse['data']> {
    return this.query(DELETE_WEBHOOK_QUERY, { id })
  }

  onRemoveEvent(event: EventConfiguration): void {
    event.options.deleteWebhookOnExit &&
      this.deleteWebhook(event.options.webhookId).then(() =>
        this.app.getLogger().info(`Removed Monday web hook id: ${event.options.webhookId}`),
      )
  }

  sdk(): MondaySdk {
    return this._sdk
  }
}

export { MondayConnector }
