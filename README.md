# kr-stock-monitor

한국투자증권 공식 WebSocket으로 국내주식 **KRX 실시간 체결가**를 보여주는 VS Code 데스크톱 확장입니다.

## 설치와 시작

1. VS Code 확장 화면(`Ctrl+Shift+X`)의 `…` → **VSIX에서 설치…**에서 `kr-stock-monitor-0.1.1.vsix`를 선택합니다.
2. `Ctrl+Shift+P` → **KR Stock Monitor: 관심 종목 추가**에서 6자리 코드와 이름을 등록합니다.
3. **KR Stock Monitor: 실전 API 키 등록**에서 실전 APP KEY와 APP SECRET을 입력합니다. 입력은 가려지며 VS Code 보안 저장소에 함께 저장합니다.
4. **KR Stock Monitor: 실전 KRX 시세 연결**을 실행합니다. 자동 연결하지 않으므로 VS Code를 다시 열면 연결 명령을 실행하세요.
5. 기본값은 **모든 종목 동시 표시**입니다. **KR Stock Monitor: 표시 방식 선택** 또는 상태 표시줄 클릭 → **표시 방식 선택**에서 모두 표시/순환 표시를 바꿀 수 있습니다. 시세는 체결 수신 즉시 갱신합니다. 마우스를 올리면 전체 관심 종목과 시각을 확인합니다.

계좌/API 신청은 [KIS Developers](https://apiportal.koreainvestment.com/intro)의 API신청에서 진행합니다. 계좌·ID 연결 후 실전 Open API를 신청하고 발급받은 키를 준비하세요. 키를 채팅·Git·`settings.json`에 넣지 마세요. 등록 취소 시 기존 키를 유지하며, 삭제는 **KR Stock Monitor: API 키 삭제**에서 확인 후 수행합니다.

## 설정 예시

종목 추가·삭제 명령 대신 사용자 `settings.json`에서 아래 설정을 편집해도 됩니다. 기존 KR Stock 확장의 `krStock.*` 설정과 별개입니다.

```json
{
  "krStockMonitor.stocks": [
    { "code": "204320", "name": "HL만도" },
    { "code": "000990", "name": "DB하이텍" },
    { "code": "108860", "name": "셀바스AI" }
  ],
  "krStockMonitor.displayMode": "all",
  "krStockMonitor.rotationInterval": 5
}
```

`displayMode`는 `"all"`(모두 표시, 기본값) 또는 `"rotate"`(순환 표시)입니다. 모두 표시에서는 종목을 ` | `로 구분합니다. 순환 표시에서는 기본 5초마다 한 종목씩 바뀌며 클릭 메뉴에서 표시할 종목을 선택할 수도 있습니다. 순환 간격은 1~60초 정수이며 순환 표시에서만 적용합니다. 창이 좁으면 동시 표시가 길어질 수 있으므로 순환 표시를 선택할 수 있습니다.

종목 코드는 중복 없는 6자리, 이름은 1~40자로 입력합니다. 연결 중 종목 목록을 바꾸면 새 목록으로 다시 연결합니다. 표시 방식·순환 간격 변경은 기존 시세와 연결을 유지한 채 바로 적용합니다.

## 상태와 확인 방법

- `연결 중` → `구독 승인 대기` → `체결 대기` → `체결 수신 중`을 구분합니다. 소켓 연결만으로 실제 시세 수신을 보장하지 않습니다.
- 최초 체결 전에는 가격이 없습니다. 장외 시간·거래 없는 종목은 체결 대기가 정상일 수 있습니다. REST 초기 현재가 조회는 포함하지 않습니다.
- 단절 시 마지막 수신 가격과 시각을 유지하면서 재연결 상태를 표시합니다. 체결 부재와 별개로 연결 전체에 90초 동안 응답이 없으면 재연결합니다.
- 네트워크 오류는 1/2/4/8/16/30초 간격으로 재시도하고 이후 30초를 유지합니다. 체결을 다시 받으면 대기를 초기화합니다. 인증·구독 거절·규격 오류는 자동 재시도하지 않습니다.
- 실패 원인은 **KR Stock Monitor: 연결 로그 보기**에서 확인합니다. 키·인증 요청 본문·원문 프레임은 기록하지 않습니다.
- 여러 VS Code 창에서 같은 키를 동시에 연결하면 증권사 연결 제한에 걸릴 수 있습니다. 우선 한 창에서 사용하세요.

**KR Stock Monitor: 가상 시세 데모 시작**은 키·외부 접속 없이 화면을 확인하는 모드입니다. `[데모]`를 표시하며 실제 오류 시 자동 전환하지 않습니다. 실전 연결로 전환하면 가상 가격을 지웁니다.

## 연결과 범위

접속키 발급은 `https://openapi.koreainvestment.com:9443/oauth2/Approval`, 시세 수신은 공식 예제의 `ws://ops.koreainvestment.com:21000/tryitout`을 사용합니다. **WS 구간은 암호화되지 않아 접속키가 전송 중 노출될 위험이 있습니다.** APP SECRET은 HTTPS 발급 요청에만 사용하고 WS 메시지에는 발급받은 접속키를 사용합니다. 접속키는 메모리에서만 보관합니다.

국내주식 KRX 체결가 `H0STCNT0`를 지원합니다. NXT·통합 시세, 차트, 지수·환율, 해외주식, 주문·계좌·잔고 조회, 개인 주문 체결통보는 포함하지 않습니다. 표시 가격은 투자 결과를 검증하는 수단이 아니라 마지막으로 수신한 KRX 체결가입니다.

개인용 로컬 VSIX입니다. Marketplace에 게시하지 않았으며 라이선스는 `UNLICENSED`입니다. 재배포·공개 서비스의 시세 이용 조건은 별도로 확인해야 합니다.

## 개발과 검증

Node 24, VS Code 1.140 이상을 대상으로 합니다. PowerShell에서:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd run package
```

F5로 개발 호스트를 열 수도 있습니다. 자동 테스트는 합성 프로토콜 메시지·가상 소켓·VS Code 대역을 사용하며 외부 API에 접속하지 않습니다. 패키징 성공과 실제 장중 수신 성공은 별개입니다.

실제 수신 확인은 키 등록 → 한 종목 연결 → 구독 승인 → 장중 체결가와 시각 변화 → 단절/재연결 순서로 수행하고 한국투자 화면과 **KRX 기준**을 맞춰 비교하세요. NXT·통합 시세와 가격이 다를 수 있습니다.

중단하려면 연결 끊기 명령 후 확장을 비활성화하세요. 삭제 전에 키 삭제 명령을 별도로 실행할 수 있습니다. 기존 KR Stock 확장과 사용자 설정은 자동으로 수정하지 않습니다.

공식 규격 참고: [인증 및 WebSocket](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/kis_auth.py), [KRX 체결가](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_stock/domestic_stock_functions_ws.py), [접속 환경](https://github.com/koreainvestment/open-trading-api/blob/main/kis_devlp.yaml).
