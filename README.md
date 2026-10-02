# claude-mods

Claude Code mod 마켓플레이스.

## 설치

```bash
claude plugin marketplace add ban-dal/claude-mods
claude plugin install usage-meter@claude-mods
```

## Mods

### usage-meter

프롬프트 위에 컨텍스트 사용량, 세션(5시간) 한도, 주간(7일) 한도를 한 줄로 표시한다.

- 리셋 전에 한도가 소진될 속도면 남은 시간 대신 소진 예상 시각을 표시
- `구성`: 컨텍스트를 차지하는 항목별 토큰
- `추이`: 세션/주간 한도의 사용 추이 그래프와 리셋 시 예상 사용률
- 한도 80%·90%, 컨텍스트 90% 도달 시 토스트
- `/usage-meter`: 표시/숨기기

## 개발

```bash
claude plugin validate plugins/usage-meter
claude plugin test plugins/usage-meter
```
