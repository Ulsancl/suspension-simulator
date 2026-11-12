# Daybreak 보안 발견 사항 검증

Daybreak의 2026-10-03 저장소 스캔에서 보고한 항목입니다. 아래 수정은 검토 브랜치의 코드와 로컬 회귀 테스트 기준이며, 운영 배포 또는 Daybreak 재스캔 완료를 뜻하지 않습니다. 기존 발견 사항은 재검증 전까지 열린 상태로 둡니다.

- [Fixed loopback launchers can hand the application origin to another local process](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_70bf2eecb577bbea1a45ec981397d7d1) (medium)
- [Schema-valid component curves can force millions of unbudgeted integration steps](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_149cdf80c14e3eeaaa1a20416dbfe99e) (low)
- [Measurement CSV column limits are enforced after attacker-sized allocation](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_697a0a825c0b4559e56a7ffcdf830311) (low)
- [Release packagers can embed files reached through uncontained input symlinks](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_c60e4ced52030fc4ade126d9354c0fe3) (low)
- [Packaging and test artifact writers trust pre-existing ignored-path symlinks](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_e2b266437cc2787bffef67e0db17bb13) (low)
- [Project imports deserialize attacker-controlled object graphs twice](https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/acf_fce2c833c069db512e89f7de70cea251) (low)

브라우저 실행기는 포트 확보 후에만 주소를 열며, 다른 프로세스의 제목 문자열로 서버를 신뢰하지 않습니다. 기존 로컬 주소의 서비스 워커가 의심스러운 경우 프로젝트를 파일로 백업한 뒤 브라우저 사이트 데이터와 서비스 워커를 삭제하고 새 배포본으로 다시 여세요.

CSV 파서는 토큰을 추가하기 전에 열·셀·행 및 전체 셀 수를 제한합니다. 부품 곡선으로 인한 계산량은 실행 전에 100,000단계 한도를 검사하고 계산 중 취소도 확인합니다. 프로젝트 입력은 JSON 객체 생성 전 크기·깊이·구조 개수를 검사하며, UI는 검증 계층의 결과를 사용합니다. 최대 12개 기록과 정상적인 30초 시험 형식은 유지합니다.

서비스 워커는 정상 HTML 루트 응답만 시작 화면에 저장합니다. 배포 입력과 산출물 경로 보호는 [빌드 보안 설명](security-builds.md)을 참고하세요.
