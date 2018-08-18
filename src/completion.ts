import { Neovim } from '@chemzqm/neovim'
import completes from './completes'
import Increment from './increment'
import Document from './model/document'
import Sources from './sources'
import { CompleteOption, SourceStat, SourceType, VimCompleteItem } from './types'
import { echoErr, isCocItem } from './util'
import { isWord } from './util/string'
import workspace from './workspace'
import Emitter = require('events')
const logger = require('./util/logger')('completion')

function onError(e): void {
  logger.error(e.stack)
}

export class Completion {
  private increment: Increment
  private lastChangedI: number
  private nvim: Neovim
  private completing = false

  public init(nvim, emitter: Emitter): void {
    this.nvim = nvim
    let increment = this.increment = new Increment(nvim)
    emitter.on('InsertCharPre', character => {
      this.onInsertCharPre(character)
    })
    emitter.on('InsertLeave', () => {
      this.onInsertLeave().catch(onError)
    })
    emitter.on('InsertEnter', () => {
      this.onInsertEnter().catch(onError)
    })
    emitter.on('TextChangedP', () => {
      this.onTextChangedP().catch(onError)
    })
    emitter.on('TextChangedI', () => {
      this.onTextChangedI().catch(onError)
    })
    emitter.on('CompleteDone', item => {
      this.onCompleteDone(item).catch(onError)
    })
    // stop change emit on completion
    let document: Document = null
    increment.on('start', option => {
      let { bufnr } = option
      document = workspace.getDocument(bufnr)
      if (document) document.paused = true
    })
    increment.on('stop', () => {
      if (!document) return
      document.paused = false
    })
  }

  private get sources(): Sources {
    return workspace.sources
  }

  private getPreference(name: string, defaultValue: any): any {
    return workspace.getConfiguration('coc.preferences').get(name, defaultValue)
  }

  public get hasLatestChangedI(): boolean {
    let { lastChangedI } = this
    return lastChangedI && Date.now() - lastChangedI < 30
  }

  public startCompletion(option: CompleteOption): void {
    this._doComplete(option).then(() => {
      this.completing = false
    }).catch(e => {
      echoErr(this.nvim, e.message)
      logger.error('Error happens on complete: ', e.stack)
    })
  }

  public async resumeCompletion(resumeInput: string): Promise<void> {
    let { nvim, increment } = this
    let oldComplete = completes.complete
    try {
      let { colnr, input } = oldComplete.option
      let opt = Object.assign({}, oldComplete.option, {
        input: resumeInput,
        colnr: colnr + resumeInput.length - input.length
      })
      logger.trace(`Resume options: ${JSON.stringify(opt)}`)
      let items = completes.filterCompleteItems(opt)
      logger.trace(`Filtered item length: ${items.length}`)
      if (!items || items.length === 0) {
        increment.stop()
        return
      }
      // make sure input not changed
      if (increment.search == resumeInput) {
        nvim.call('coc#_set_context', [opt.col, items], true)
        await nvim.call('coc#_do_complete', [])
      }
    } catch (e) {
      echoErr(nvim, `completion error: ${e.message}`)
      logger.error(e.stack)
    }
  }

  public toggleSource(name: string): void {
    if (!name) return
    let source = this.sources.getSource(name)
    if (!source) return
    if (typeof source.toggle === 'function') {
      source.toggle()
    }
  }

  public async sourceStat(): Promise<SourceStat[]> {
    let res: SourceStat[] = []
    let filetype = await this.nvim.eval('&filetype') as string
    let items = this.sources.getSourcesForFiletype(filetype)
    for (let item of items) {
      res.push({
        name: item.name,
        filepath: item.filepath || '',
        type: item.sourceType == SourceType.Native
          ? 'native' : item.sourceType == SourceType.Remote
            ? 'remote' : 'service',
        disabled: !item.enable
      })
    }
    return res
  }

  private async _doComplete(option: CompleteOption): Promise<void> {
    if (this.completing) return
    this.completing = true
    let { nvim, increment } = this
    // could happen for auto trigger
    increment.start(option)
    let { input } = option
    logger.trace(`options: ${JSON.stringify(option)}`)
    let sources = this.sources.getCompleteSources(option)
    logger.trace(`Activted sources: ${sources.map(o => o.name).join(',')}`)
    let items = await completes.doComplete(sources, option)
    if (items.length == 0) {
      increment.stop()
      return
    }
    let { search } = increment
    if (search === input) {
      nvim.call('coc#_set_context', [option.col, items], true)
      await nvim.call('coc#_do_complete', [])
    } else {
      if (search) {
        await this.resumeCompletion(search)
      } else {
        increment.stop()
      }
    }
  }

  private async onTextChangedP(): Promise<void> {
    let { increment } = this
    if (increment.latestInsert) {
      if (!increment.isActivted || this.completing) return
      let search = await increment.getResumeInput()
      if (search) await this.resumeCompletion(search)
      return
    }
    if (this.completing || this.hasLatestChangedI) return
    let { option } = completes
    let search = await this.nvim.call('coc#util#get_search', [option.col])
    if (search == null) return
    let item = completes.getCompleteItem(search)
    if (item) await this.sources.doCompleteResolve(item)
  }

  private async onTextChangedI(): Promise<void> {
    this.lastChangedI = Date.now()
    let { nvim, increment } = this
    let { latestInsertChar } = increment
    if (increment.isActivted) {
      if (this.completing) return
      let search = await increment.getResumeInput()
      if (search != null) return await this.resumeCompletion(search)
      if (latestInsertChar && isWord(latestInsertChar)) return
    } else if (increment.search && !latestInsertChar) {
      // restart when user correct search
      let [, lnum] = await nvim.call('getcurpos')
      let { option } = completes
      if (lnum == option.linenr) {
        let search = await this.nvim.call('coc#util#get_search', [option.col])
        if (search.length < increment.search.length) {
          option.input = search
          increment.start(option)
          await this.resumeCompletion(search)
          return
        }
      }
    }
    if (increment.isActivted || !latestInsertChar) return
    // check trigger
    let shouldTrigger = await this.shouldTrigger(latestInsertChar)
    if (!shouldTrigger) return
    let option = await nvim.call('coc#util#get_complete_option')
    Object.assign(option, { triggerCharacter: latestInsertChar })
    logger.trace('trigger completion with', option)
    this.startCompletion(option)
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    if (!isCocItem(item)) return
    let { increment } = this
    try {
      increment.stop()
      completes.addRecent(item.word)
      await this.sources.doCompleteDone(item)
      completes.reset()
    } catch (e) {
      logger.error(`error on complete done`, e.message)
    }
  }

  private async onInsertLeave(): Promise<void> {
    await this.nvim.call('coc#_hide')
    this.increment.stop()
  }

  private async onInsertEnter(): Promise<void> {
    let autoTrigger = this.getPreference('autoTrigger', 'always')
    if (autoTrigger !== 'always') return
    let trigger = this.getPreference('triggerAfterInsertEnter', true)
    if (trigger) {
      let option = await this.nvim.call('coc#util#get_complete_option')
      this.startCompletion(option)
    }
  }

  private onInsertCharPre(character: string): void {
    let { increment } = this
    increment.lastInsert = {
      character,
      timestamp: Date.now(),
    }
  }

  private async shouldTrigger(character: string): Promise<boolean> {
    if (!character || character == ' ') return false
    let { nvim, sources } = this
    let autoTrigger = this.getPreference('autoTrigger', 'always')
    if (autoTrigger == 'none') return false
    if (isWord(character)) {
      let input = await nvim.call('coc#util#get_input') as string
      return input.length > 0
    } else {
      let buffer = await nvim.buffer
      let languageId = await buffer.getOption('filetype') as string
      return sources.shouldTrigger(character, languageId)
    }
    return false
  }

  public dispose(): void {
    if (this.increment) {
      this.increment.removeAllListeners()
      this.increment.stop()
    }
    if (this.sources) {
      this.sources.dispose()
    }
  }
}

export default new Completion()
