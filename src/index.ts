import { Reshuffle, BaseHttpConnector, EventConfiguration } from 'reshuffle-base-connector'
import { Request, Response, NextFunction } from 'express'
import mondaySdk from 'monday-sdk-js'

const DEFAULT_WEBHOOK_PATH = '/monday-event'

export interface MondayConnectorConfigOptions {
  token: string
}

export interface MondayConnectorEventOptions {
  boardId: number
  base_url: string
  eventType:
    | 'incoming_notification'
    | 'change_column_value'
    | 'change_specific_column_value'
    | 'create_item'
    | 'create_update'
  path?: string
  webhookId?: string
  deleteWebhookOnExit?: boolean
}

interface MondayApiReponse {
  data?: Record<string, unknown>
  errors?: Record<string, unknown>[]
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
mutation ($board_id: Int!, $group_id: String, $item_name: String) {
  create_item (board_id: $board_id, group_id: $group_id, item_name: $item_name) {
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
mutation($board_id: Int!, $url: String!, $event: WebhookEventType!) {
  create_webhook ( board_id: $board_id, url: $url, event: $event) {
  id
    board_id
  }
}`

const DELETE_WEBHOOK_QUERY = `#graphql
mutation($id: Int!) {
  delete_webhook ( id: $id) {
    id
    board_id
  }
}`

export default class MondayConnector extends BaseHttpConnector<
  MondayConnectorConfigOptions,
  MondayConnectorEventOptions
> {
  _sdk: MondaySdk

  constructor(app: Reshuffle, options: MondayConnectorConfigOptions, id?: string) {
    super(app, options, id)
    this._sdk = mondaySdk({ token: options.token })
  }

  async _api(...params: Parameters<MondaySdk['api']>): Promise<MondayApiReponse['data']> {
    const res = await this._sdk.api(...params)
    if ('data' in res) return res.data
    throw new Error(
      res.errors?.length && typeof res.errors[0].message === 'string'
        ? res.errors[0].message
        : undefined,
    )
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
      ).then((x?: Record<string, any>) => {
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

  getBoard(boardIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this._api(GET_BOARD_QUERY, { variables: { board_ids: boardIds } })
  }

  getColumn(boardIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this._api(GET_COLUMNS_QUERY, { variables: { board_ids: boardIds } })
  }

  getGroup(
    boardIds: number | number[],
    groupIds: string | string[],
  ): Promise<MondayApiReponse['data']> {
    return this._api(GET_GROUPS_QUERY, {
      variables: { board_ids: boardIds, group_ids: groupIds },
    })
  }

  getItem(itemIds: number | number[]): Promise<MondayApiReponse['data']> {
    return this._api(GET_ITEMS_QUERY, {
      variables: { item_ids: itemIds },
    })
  }

  createItem(
    boardId: number,
    itemName?: string,
    groupId?: string,
  ): Promise<MondayApiReponse['data']> {
    return this._api(CREATE_ITEM_QUERY, {
      variables: { board_id: boardId, group_id: groupId, item_name: itemName },
    })
  }

  updateItem(
    boardId: number,
    groupId: string,
    itemName: string,
  ): Promise<MondayApiReponse['data']> {
    return this._api(UPDATE_ITEM_QUERY, {
      variables: { board_id: boardId, group_id: groupId, item_name: itemName },
    })
  }

  createWebhook(boardId: number, url: string, event: string): Promise<MondayApiReponse['data']> {
    return this._api(CREATE_WEBHOOK_QUERY, {
      variables: { board_id: boardId, url, event },
    })
  }

  deleteWebhook(id: number): Promise<MondayApiReponse['data']> {
    return this._api(DELETE_WEBHOOK_QUERY, {
      variables: { id },
    })
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
