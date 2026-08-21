import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { KgPage } from './kg/KgPage';
import { RoomsPage } from './ui/RoomsPage';
import './styles.css';

/**
 * 三个页面共用一个入口，靠查询参数分。
 *
 * 没上路由库：一共三个页面，其中两个是只读的，
 * 装一个 router 换来的是一层要维护的抽象，省下的是这几行。
 *
 *   ?room=<名字>   画布本体
 *   ?view=kg       知识图谱
 *   （什么都不带）  画布列表——门厅
 *
 * 不带参数时进列表而不是进一个叫 default 的画布：攒到二十几张之后，
 * 落地在一张空白画布上对"我上次那道题在哪"这个问题毫无帮助。
 * 想直接进原来那张，?room=default 照旧管用。
 */
const params = new URLSearchParams(location.search);
const view = params.get('view');
const hasRoom = params.has('room');

function Page() {
  if (view === 'kg') return <KgPage />;
  if (view === 'rooms' || !hasRoom) return <RoomsPage />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
