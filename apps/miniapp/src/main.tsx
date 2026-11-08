import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ProformaScreen } from './proforma';
import '@fontsource/vazirmatn/arabic-400.css';
import '@fontsource/vazirmatn/arabic-500.css';
import '@fontsource/vazirmatn/arabic-700.css';
import '@fontsource/vazirmatn/arabic-800.css';
import '@fontsource/vazirmatn/latin-400.css';
import '@fontsource/vazirmatn/latin-700.css';
import './styles.css';
// a shared, read-only proforma link (?doc=…) opens the document alone, without signing in
const doc = new URLSearchParams(location.search).get('doc');
createRoot(document.getElementById('root')!).render(doc ? <main className="pubdoc"><ProformaScreen token={doc} /></main> : <App />);
