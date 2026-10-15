import * as vscode from 'vscode';
import { createClient, Credentials, KisClient, State } from './kisClient';
import { formatQuote, Quote, Stock, validateStocks } from './quote';

const SECRET_KEY = 'kis.real.credentials.v1';
const PREFIX = 'krStockMonitor';
let monitor: Monitor | undefined;

class Monitor implements vscode.Disposable {
  private readonly bar = vscode.window.createStatusBarItem('kr-stock-monitor', vscode.StatusBarAlignment.Right, 0);
  private readonly output = vscode.window.createOutputChannel('KR Stock Monitor');
  private readonly client: KisClient;
  private readonly quotes = new Map<string, Quote>();
  private stocks: Stock[] = [];
  private state: State = { kind: 'idle', message: '연결 안 됨' };
  private mode: 'idle' | 'real' | 'demo' = 'idle';
  private displayMode: 'all' | 'rotate' = 'all';
  private rotation?: ReturnType<typeof setInterval>;
  private demoTimer?: ReturnType<typeof setInterval>;
  private selected = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bar.name = 'KR Stock Monitor';
    this.bar.command = `${PREFIX}.menu`;
    this.client = createClient(() => this.readKeys(), state => {
      if (this.disposed) return;
      if (this.state.message !== state.message) this.output.appendLine(`${new Date().toISOString()} ${state.message}`);
      this.state = state;
      this.render();
    }, quote => { if (!this.disposed) { this.quotes.set(quote.code, quote); this.render(); } });
    const commands: Record<string, () => unknown> = {
      menu: () => this.menu(), connect: () => this.connect(), disconnect: () => this.disconnect(),
      registerKeys: () => this.registerKeys(), removeKeys: () => this.removeKeys(),
      addStock: () => this.addStock(), removeStock: () => this.removeStock(),
      demo: () => this.demo(), displayMode: () => this.chooseDisplayMode(), showLogs: () => this.output.show()
    };
    for (const [name, handler] of Object.entries(commands)) {
      context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, async () => {
        try { await handler(); } catch { void vscode.window.showErrorMessage('작업을 완료하지 못했습니다. 설정 또는 보안 저장소 접근 상태를 확인하세요.'); }
      }));
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(PREFIX)) return;
      if (!event.affectsConfiguration(`${PREFIX}.stocks`)) { this.configure(); return; }
      const previousMode = this.mode;
      this.disconnect();
      this.quotes.clear();
      if (this.configure()) {
        if (previousMode === 'real') this.connect();
        else if (previousMode === 'demo') this.demo();
      }
    }));
    context.subscriptions.push(context.secrets.onDidChange(event => {
      if (event.key === SECRET_KEY && this.mode === 'real') this.disconnect();
    }));
    this.configure();
  }

  private configure(): boolean {
    if (this.rotation) clearInterval(this.rotation);
    this.rotation = undefined;
    try {
      const config = vscode.workspace.getConfiguration(PREFIX);
      this.stocks = validateStocks(config.get('stocks', []));
      const displayMode = config.get<string>('displayMode', 'all');
      if (displayMode !== 'all' && displayMode !== 'rotate') throw new Error('표시 방식은 all 또는 rotate로 설정하세요.');
      this.displayMode = displayMode;
      this.selected = 0;
      if (this.displayMode === 'rotate') {
        const seconds = config.get<number>('rotationInterval', 5);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('순환 간격은 1~60초 정수로 설정하세요.');
        if (this.stocks.length > 1) this.rotation = setInterval(() => {
          this.selected = (this.selected + 1) % this.stocks.length;
          this.render();
        }, seconds * 1000);
      }
      this.render();
      return true;
    } catch (error) {
      this.disconnect();
      this.stocks = [];
      this.state = { kind: 'error', message: error instanceof Error ? error.message : '설정 오류' };
      this.render();
      return false;
    }
  }

  private async readKeys(): Promise<Credentials | undefined> {
    const saved = await this.context.secrets.get(SECRET_KEY);
    if (!saved) return undefined;
    const keys = JSON.parse(saved) as Partial<Credentials> | null;
    if (typeof keys?.appKey !== 'string' || !keys.appKey.trim()
      || typeof keys.appSecret !== 'string' || !keys.appSecret.trim()) throw new Error('Invalid stored credentials');
    return { appKey: keys.appKey, appSecret: keys.appSecret };
  }

  private async registerKeys(): Promise<void> {
    const options = { password: true, ignoreFocusOut: true, validateInput: (value: string) => value.trim() ? undefined : '값을 입력하세요.' };
    const appKey = await vscode.window.showInputBox({ ...options, title: '한국투자 실전 APP KEY', prompt: '발급받은 실전 키를 입력하세요. VS Code 보안 저장소에 저장합니다.' });
    if (!appKey?.trim() || this.disposed) return;
    const appSecret = await vscode.window.showInputBox({ ...options, title: '한국투자 실전 APP SECRET', prompt: '채팅·settings.json에 입력하지 마세요.' });
    if (!appSecret?.trim() || this.disposed) return;
    this.disconnect();
    await this.context.secrets.store(SECRET_KEY, JSON.stringify({ appKey: appKey.trim(), appSecret: appSecret.trim() }));
    if (!this.disposed) void vscode.window.showInformationMessage('실전 API 키를 저장했습니다. KR Stock Monitor: 실전 KRX 시세 연결을 실행하세요.');
  }

  private async removeKeys(): Promise<void> {
    const answer = await vscode.window.showWarningMessage('등록한 실전 API 키를 보안 저장소에서 삭제할까요?', { modal: true }, '삭제');
    if (answer !== '삭제' || this.disposed) return;
    this.disconnect();
    await this.context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('등록한 키를 삭제했습니다.');
  }

  private connect(): void {
    if (this.disposed) return;
    this.disconnect();
    if (!this.configure()) return;
    this.mode = 'real';
    // Demo values must never be reused as live prices.
    this.quotes.clear();
    this.client.start(this.stocks);
  }

  private disconnect(): void {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = undefined;
    const wasDemo = this.mode === 'demo';
    this.mode = 'idle';
    if (wasDemo) this.quotes.clear();
    this.client.stop();
    this.render();
  }

  private demo(): void {
    if (this.disposed) return;
    this.disconnect();
    if (!this.configure()) return;
    if (!this.stocks.length) { void vscode.window.showInformationMessage('관심 종목을 먼저 추가하세요.'); return; }
    this.mode = 'demo';
    let tick = 0;
    const update = (): void => {
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
      const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false });
      this.stocks.forEach((stock, index) => this.quotes.set(stock.code, { code: stock.code, price: 10_000 + index * 1000 + tick * 10,
        changeRate: ((tick % 7) - 3) / 10, tradeTime: time, tradeDate: date, receivedAt: Date.now() }));
      tick++;
      this.state = { kind: 'live', message: '데모 · 가상 데이터' };
      this.render();
    };
    update();
    this.demoTimer = setInterval(update, 1000);
  }

  private async addStock(): Promise<void> {
    const code = await vscode.window.showInputBox({ title: '관심 종목 코드', placeHolder: '예: 204320', validateInput: value => /^\d{6}$/.test(value.trim()) ? undefined : '종목 코드 6자리를 입력하세요.' });
    if (!code || this.disposed) return;
    const name = await vscode.window.showInputBox({ title: '종목 표시 이름', placeHolder: '예: HL만도', validateInput: value => value.trim() && value.trim().length <= 40 && !/[\r\n\t]/.test(value) ? undefined : '1~40자로 입력하세요.' });
    if (!name || this.disposed) return;
    const config = vscode.workspace.getConfiguration(PREFIX);
    const stocks = validateStocks([...validateStocks(config.get('stocks', [])), { code: code.trim(), name: name.trim() }]);
    await config.update('stocks', stocks, vscode.ConfigurationTarget.Global);
  }

  private async removeStock(): Promise<void> {
    const config = vscode.workspace.getConfiguration(PREFIX);
    const stocks = validateStocks(config.get('stocks', []));
    const picked = await vscode.window.showQuickPick(stocks.map(stock => ({ label: stock.name, description: stock.code, stock })), { title: '삭제할 관심 종목' });
    if (!picked || this.disposed) return;
    await config.update('stocks', stocks.filter(stock => stock.code !== picked.stock.code), vscode.ConfigurationTarget.Global);
  }

  private async chooseDisplayMode(): Promise<void> {
    const picked = await vscode.window.showQuickPick([
      { label: '모두 표시', description: '모든 관심 종목을 한 번에 표시', value: 'all' },
      { label: '순환 표시', description: '한 종목씩 순서대로 표시', value: 'rotate' }
    ], { title: 'KR Stock Monitor 표시 방식' });
    if (picked && !this.disposed) await vscode.workspace.getConfiguration(PREFIX).update('displayMode', picked.value, vscode.ConfigurationTarget.Global);
  }

  private async menu(): Promise<void> {
    const options: { label: string; description?: string; command?: string; index?: number }[] = this.displayMode === 'rotate' ? this.stocks.map((stock, index) => ({
      label: stock.name, description: `${stock.code} · ${this.quotes.has(stock.code) ? formatQuote(this.quotes.get(stock.code)!) : '체결 대기'}`, index
    })) : [];
    options.push(...[
      ['실전 KRX 시세 연결', 'connect'], ['연결 끊기', 'disconnect'], ['실전 API 키 등록', 'registerKeys'],
      ['관심 종목 추가', 'addStock'], ['관심 종목 삭제', 'removeStock'], ['표시 방식 선택', 'displayMode'], ['가상 시세 데모', 'demo'], ['연결 로그 보기', 'showLogs']
    ].map(([label, command]) => ({ label, command: `${PREFIX}.${command}` })));
    const picked = await vscode.window.showQuickPick(options, { title: `KR Stock Monitor · ${this.state.message}` });
    if (!picked || this.disposed) return;
    if (picked.index !== undefined) { this.selected = picked.index; this.render(); }
    else if (picked.command) await vscode.commands.executeCommand(picked.command);
  }

  private render(): void {
    if (this.disposed) return;
    const visibleStocks = this.displayMode === 'all' ? this.stocks : this.stocks.slice(this.selected, this.selected + 1);
    const text = visibleStocks.map(stock => {
      const quote = this.quotes.get(stock.code);
      return `${stock.name} ${quote ? formatQuote(quote) : '시세 대기'}`;
    }).join(' | ');
    const prefix = this.mode === 'demo' ? '[데모] ' : '[KRX] ';
    const status = this.state.kind === 'live' && this.mode === 'real' ? '' : ` · ${this.state.message}`;
    this.bar.text = text ? `${prefix}${text}${status}` : `KR Stock · ${this.state.kind === 'error' ? this.state.message : '관심 종목 추가'}`;
    const rows = this.stocks.map(item => {
      const q = this.quotes.get(item.code);
      const time = q ? new Date(q.receivedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }) : '';
      return `${item.name} (${item.code}) ${q ? `${formatQuote(q)}\n  체결 ${q.tradeDate} ${q.tradeTime} · 수신 ${time} KST` : '체결 대기'}`;
    });
    this.bar.tooltip = [`${this.mode === 'demo' ? '데모 가상 시세' : '한국투자증권 · 실전 KRX'}`, this.state.message,
      ...rows, '가격은 마지막 수신 체결가입니다. 장외·무체결 시 갱신되지 않습니다.', '클릭: 종목 및 연결 메뉴'].join('\n');
    this.bar.show();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.stop();
    if (this.rotation) clearInterval(this.rotation);
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.quotes.clear();
    this.bar.dispose();
    this.output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  monitor = new Monitor(context);
  context.subscriptions.push(monitor);
}

export function deactivate(): void { monitor?.dispose(); monitor = undefined; }
