import { Request, Response } from 'express'
import { Reshuffle, BaseHttpConnector, EventConfiguration } from 'reshuffle-base-connector'
import mondaySdk from 'monday-sdk-js'

const WEBHOOK_PATH = '/webhooks/monday'

export interface MondayConnectorConfigOptions {
  token: string
  baseURL?: string
  webhookPath?: string
}

const MONDAY_ID_REGEX = /^\d{9,10}$/

export interface MondayConnectorEventOptions {
  boardId: string | number
  type:
    | 'IncomingNotification'
    | 'ChangeColumnValue'
    | 'ChangeSpecificColumnValue'
    | 'CreateItem'
    | 'CreateUpdate'
  columnId?: string // for type === ChangeSpecificColumnValue
}

// Translate JavaScript friendly names into Monday event names.
const JS_TO_MONDAY_EVENT_NAMES = {
  IncomingNotification: 'incoming_notification',
  ChangeColumnValue: 'change_column_value',
  ChangeSpecificColumnValue: 'change_specific_column_value',
  CreateItem: 'create_item',
  CreateUpdate: 'create_update',
}

// Translate Monday event names into JavaScript friendly names. Some
// Monday names appear differently in the documentation and the actual
// event data so they appear here twice to be on the safe side.
const MONDAY_TO_JS_EVENT_NAMES = {
  incoming_notification: 'IncomingNotification',
  change_column_value: 'ChangeColumnValue',
  update_column_value: 'ChangeColumnValue',
  change_specific_column_value: 'ChangeSpecificColumnValue',
  update_specific_column_value: 'ChangeSpecificColumnValue',
  create_item: 'CreateItem',
  create_update: 'CreateUpdate',
}

interface MondayEvent {
  userId: string
  originalTriggerUuid: any
  boardId: string
  groupId: string
  itemId: string // Copid from the pulseId field to match new API terms
  pulseId: string // pulseId
  itemName: string // Copid from the pulseName field to match new API terms
  pulseName: string // pulseName
  columnId: string
  columnType: string
  columnTitle: string
  value: { value: any }
  previousValue: { value: any }
  changedAt: number
  isTopGroup: boolean
  type: string
  triggerTime: string
  subscriptionId: string
  triggerUuid: string
}

interface MondayApiReponse {
  data?: Record<string, any>
  errors?: Record<string, any>[]
  error_message?: string
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
mutation ($board_id: Int!, $group_id: String, $item_name: String, $column_values: JSON) {
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
  }
}`

const DELETE_WEBHOOK_QUERY = `#graphql
mutation($id: Int!) {
  delete_webhook ( id: $id ) {
    id
  }
}`

export class MondayError extends Error {
  constructor(public res: MondayApiReponse) {
    super(
      `Monday API Error${
        res.errors
          ? res.errors.length === 1
            ? res.errors[0].message
            : `s (${res.errors.length})`
          : res.error_message
          ? res.error_message
          : ''
      }`,
    )
  }
}

export default class MondayConnector extends BaseHttpConnector<
  MondayConnectorConfigOptions,
  MondayConnectorEventOptions
> {
  _sdk: MondaySdk
  private webhookPath: string
  private webhookURL?: string
  private webhookLastChangedAt?: number

  constructor(app: Reshuffle, options: MondayConnectorConfigOptions, id?: string) {
    super(app, options, id)
    const base = validateBaseURL(options.baseURL)
    this.webhookPath = validatePath(options.webhookPath) || WEBHOOK_PATH
    if (base) {
      this.webhookURL = base + this.webhookPath
    }
    this._sdk = mondaySdk({ token: options.token })
  }

  async onStart(): Promise<void> {
    if (0 < Object.keys(this.eventConfigurations).length) {
      this.app.registerHTTPDelegate(this.webhookPath, this)
    }
  }

  on(
    options: MondayConnectorEventOptions,
    handler: (event: MondayEvent) => void,
    eventId?: string,
  ): EventConfiguration {
    const boardId = String(options.boardId)
    if (!MONDAY_ID_REGEX.test(boardId)) {
      throw new Error(`Invalid board id: ${options.boardId}`)
    }
    if (!JS_TO_MONDAY_EVENT_NAMES[options.type]) {
      throw new Error(`Invalid event type: ${options.type}`)
    }
    if (
      options.type === 'ChangeSpecificColumnValue' &&
      !MONDAY_ID_REGEX.test(options.columnId || '')
    ) {
      throw new Error(`Invalid column id for type ChangeSpecificColumnValue: ${options.columnId}`)
    }

    const event = new EventConfiguration(
      eventId || `MondayConnector/${options.boardId}/${options.type}/${this.id}`,
      this,
      { boardId, type: options.type, columnId: options.columnId },
    )
    this.eventConfigurations[event.id] = event
    this.app.when(event, handler as any)

    return event
  }

  onRemoveEvent(ec: EventConfiguration): void {
    delete this.eventConfigurations[ec.id]
  }

  async handle(req: Request, res: Response): Promise<boolean> {
    if (req.body.challenge) {
      this.app.getLogger().info('Handling Monday web hook challenge')
      res.json({ challenge: req.body.challenge })
    } else if (this.started) {
      const ev = req.body.event
      if (this.webhookLastChangedAt !== ev.changedAt) {
        await this.handleWebhookEvent(ev)
        this.webhookLastChangedAt = ev.changedAt
      }
    }

    return true
  }

  private async handleWebhookEvent(ev: Record<string, any>) {
    const event: MondayEvent = {
      userId: String(ev.userId),
      originalTriggerUuid: ev.originalTriggerUuid,
      boardId: String(ev.boardId),
      groupId: ev.groupId,
      itemId: String(ev.pulseId),
      pulseId: String(ev.pulseId),
      itemName: ev.pulseName,
      pulseName: ev.pulseName,
      columnId: ev.columnId,
      columnType: ev.columnType,
      columnTitle: ev.columnTitle,
      value: ev.value,
      previousValue: ev.previousValue,
      changedAt: ev.changedAt,
      isTopGroup: ev.isTopGroup,
      type: MONDAY_TO_JS_EVENT_NAMES[ev.type],
      triggerTime: ev.triggerTime,
      subscriptionId: String(ev.subscriptionId),
      triggerUuid: ev.triggerUuid,
    }
    this.app.getLogger().info(`Handling Monday event: boardId=${event.boardId} type=${event.type}`)

    for (const ec of Object.values(this.eventConfigurations)) {
      const o = ec.options
      if (o.boardId === event.boardId && o.type === event.type) {
        await this.app.handleEvent(ec.id, event)
      }
    }
  }

  async query(qs: string, variables?: Record<string, any>): Promise<MondayApiReponse['data']> {
    const res = await this._sdk.api(qs, variables ? { variables } : undefined)
    if ('data' in res) {
      return res.data
    }
    throw new MondayError(res)
  }

  private columnValuesToObject(
    columnValues: { title: string; type: string; value: string }[],
    mapper: (value: any) => any = (x) => x,
  ): Record<string, any> {
    const obj: Record<string, any> = {}
    for (const cv of columnValues) {
      const str = JSON.parse(cv.value)
      const val = cv.type === 'numeric' ? parseInt(str) : str
      obj[cv.title] = mapper(val)
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
  ): Promise<{
    name: any
    items: any
  }> {
    const res = await this.query(`
      query {
        boards (ids: ${boardId}) {
          name
          items {
            id
            name
            column_values {
              title
              type
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
      items[item.id].id = item.id
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

  async createItem(
    boardId: number,
    itemName?: string,
    columnValues?: Record<string, (value: string) => any>,
    groupId?: string,
  ): Promise<string> {
    const res = await this.query(CREATE_ITEM_QUERY, {
      board_id: boardId,
      group_id: groupId,
      item_name: itemName,
    })
    const itemId: string = (res as any).create_item.id
    if (columnValues) {
      this.updateColumnValues(boardId, itemId, columnValues)
    }
    return itemId
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

  async updateColumnValues(
    boardId: number | string,
    itemId: number | string,
    updaters: Record<string, (value: string) => any>,
  ): Promise<void> {
    const data = await this.query(`
      query {
        items (ids: ${itemId}) {
          column_values {
            id
            title
            value
          }
        }
      }
    `)
    if (!data) {
      throw new Error(`Unable to read item: ${itemId}`)
    }

    const newValues: any = {}
    const columnValues = data.items[0].column_values
    for (const title of Object.keys(updaters)) {
      const cv = columnValues.find((cv) => cv.title === title)
      if (!cv) {
        throw new Error(`Column title not found: ${title}`)
      }
      const updater = updaters[title]
      if (typeof updater !== 'function') {
        throw new Error(`Missing or invalid updater for: ${title}`)
      }
      const value = JSON.parse(cv.value)
      newValues[cv.id] = String(updater(value))
    }

    await this.query(`
      mutation {
        change_multiple_column_values (
          board_id: ${boardId},
          item_id: ${itemId},
          column_values: ${JSON.stringify(JSON.stringify(newValues))}
        ) {
          id
        }
      }
    `)
  }

  async createWebhook(
    boardId: number | string,
    url: string,
    event: string,
    columnId?: string,
  ): Promise<string> {
    const params: any = { board_id: Number(boardId), url, event }
    if (event === 'ChangeSpecificColumnValue') {
      params.config = { columnId }
    }
    const res = await this.query(CREATE_WEBHOOK_QUERY, params)
    if (!res) {
      throw new Error(`Failed to create webhook: boardId=${boardId} event=${event}`)
    }
    return res.create_webhook.id
  }

  async createEventWebhook(
    boardId: number | string,
    event: MondayConnectorEventOptions['type'],
    columnId?: string,
  ): Promise<string> {
    if (!this.webhookURL) {
      throw new Error('Base URL not configured')
    }
    return this.createWebhook(boardId, this.webhookURL, JS_TO_MONDAY_EVENT_NAMES[event], columnId)
  }

  deleteWebhook(id: number): Promise<MondayApiReponse['data']> {
    return this.query(DELETE_WEBHOOK_QUERY, { id })
  }

  sdk(): MondaySdk {
    return this._sdk
  }
}

function validateBaseURL(url?: string): string | undefined {
  if (typeof url === 'undefined') {
    return
  }
  if (typeof url !== 'string') {
    throw new Error(`Invalid url: ${url}`)
  }
  const match = url.match(/^(https:\/\/[\w-]+(\.[\w-]+)*(:\d{1,5})?)\/?$/)
  if (!match) {
    throw new Error(`Invalid url: ${url}`)
  }
  return match[1]
}

function validatePath(path?: string): string | undefined {
  if (typeof path === 'undefined') {
    return
  }
  if (typeof path !== 'string') {
    throw new Error(`Invalid path: ${path}`)
  }
  const match = path.match(/^\/?([\w\.-]+(\/[\w\.-]+)*)\/?$/)
  if (!match) {
    throw new Error(`Invalid path: ${path}`)
  }
  return '/' + match[1]
}

export { MondayConnector }
