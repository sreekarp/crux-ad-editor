import { lazy, Suspense } from 'react';
import RenderRoute from './render/RenderRoute';

const Editor = lazy(() => import('./editor/Editor'));

const params = new URLSearchParams(window.location.search);
const renderSpec = params.get('render');

export default function App() {
  if (renderSpec) {
    return <RenderRoute spec={renderSpec} sizeKey={params.get('size') ?? '4:5'} fix={params.get('fix') === '1'} />;
  }
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-slate-500">Loading editor…</div>}>
      <Editor />
    </Suspense>
  );
}
