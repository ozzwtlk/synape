import { createRoot } from 'react-dom/client';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@xyflow/react/dist/base.css';
import './theme.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
