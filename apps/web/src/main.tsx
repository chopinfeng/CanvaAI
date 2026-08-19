import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { KgPage } from './kg/KgPage';
import './styles.css';

/**
 * 两个页面共用一个入口，靠 ?view=kg 分。
 *
 * 没上路由库：一共两个页面，其中一个还是纯只读的，
 * 装一个 router 换来的是一层要维护的抽象，省下的是这四行。
 */
const view = new URLSearchParams(location.search).get('view');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{view === 'kg' ? <KgPage /> : <App />}</StrictMode>,
);
