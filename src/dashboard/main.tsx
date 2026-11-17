import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { boot } from './lib/boot';
import './styles.css';

// Start the page chunk and the first requests now, while React is still loading the rest.
boot();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
