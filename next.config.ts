import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 백엔드 없이 정적 HTML로만 빌드 (Vercel 정적 호스팅)
  output: "export",
  images: { unoptimized: true },
  // 개발 모드 좌측 하단의 Next.js 도구 버튼(영어 전용)을 숨긴다. 배포본에는 원래 없다
  devIndicators: false,
  // 개발 서버를 같은 와이파이의 아이폰에서 열 때(http://192.168.0.34:3000) - 허용하지 않은 주소는 화면 코드·HMR을 막아
  // 서버가 그린 점만 보이고 아무것도 눌리지 않았다. 개발 모드에서만 쓰인다
  allowedDevOrigins: ["192.168.0.34", "192.168.0.99"],
  // 루트 레이아웃이 두 개((home)·[locale])라 사이트 전체 404는 app/global-not-found.tsx로 만든다
  experimental: { globalNotFound: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
