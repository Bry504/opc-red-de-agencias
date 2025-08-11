import "@/styles/globals.css";
import '@/styles/form.css'; // ⬅️ importa el estilo
import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
