# 외부 소프트웨어 고지

배포 앱은 Three.js 0.180.0과 Three.js 예제 모듈을 사용한다. 이 라이브러리의 MIT 고지 전문을 웹 ZIP의 `app/THREE-LICENSE.txt`, Windows 설치 폴더의 `resources/THREE-LICENSE.txt`에 포함한다. 원본 빌드에서는 `public/THREE-LICENSE.txt`, `dist/THREE-LICENSE.txt`에 있다. 재배포할 때 이 고지를 유지한다. [Three.js r180 원본 라이선스](https://github.com/mrdoob/three.js/blob/r180/LICENSE)를 확인할 수 있다.

Windows 설치 앱은 Electron **44.5.1** 실행 환경과 그 안의 Chromium·Node.js 및 관련 구성요소를 포함한다. Electron의 라이선스 고지는 설치 폴더의 `LICENSE.electron.txt`, Chromium과 포함 구성요소의 고지는 `LICENSES.chromium.html`에 있다. 이 파일들을 앱과 함께 유지한다. 소스 의존성은 `package-lock.json`에 고정한다.

2026-10-01 실제 설치본에서 `LICENSE.electron.txt`, `LICENSES.chromium.html`과 `resources/THREE-LICENSE.txt`가 존재하는 것을 확인했다.

Vite, Playwright와 electron-builder는 개발·빌드·검증 도구이며 해당 실행 패키지를 웹 ZIP 또는 Windows 앱에 포함하지 않는다. 3D 형상과 스튜디오 환경은 앱 코드에서 생성하며 외부 CAD, 폰트, 사진 또는 HDR 파일을 배포하지 않는다.

앱 자체의 판매 조건, 소스 라이선스, 상표 및 고객 지원 정책은 제품 소유자가 별도로 결정해야 한다. 이 문서는 외부 라이브러리 고지이며 앱 전체의 라이선스를 지정하지 않는다.
