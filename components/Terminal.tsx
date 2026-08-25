
import React, { useState, useRef, useEffect } from 'react';
import { analyzeMarketSignal } from '../services/geminiService';
import { SignalAnalysis } from '../types';
import { Loader2, Terminal as TerminalIcon, ChevronRight, Zap } from 'lucide-react';

const Terminal: React.FC = () => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<SignalAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    setLoading(true);
    setError(null);
    try {
      const result = await analyzeMarketSignal(input);
      setAnalysis(result);
    } catch (err) {
      setError('System failure: Check API key or connection.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-5 md:p-8 glass-card rounded-none border-l-2 md:border-l-4 border-l-accent shadow-2xl bg-black/40">
      <div className="flex items-center gap-3 mb-6 font-mono text-[9px] md:text-xs tracking-widest text-accent uppercase">
        <TerminalIcon size={14} className="text-accent/60" />
        <span className="opacity-50">MERCURY_AI_TERMINAL_V.2.5</span>
      </div>

      <div ref={terminalRef} className="space-y-6 md:space-y-8 font-mono text-xs md:text-sm">
        <div className="space-y-2">
          <form onSubmit={handleSubmit} className="flex gap-3 items-center border-b border-white/5 pb-2 focus-within:border-accent/50 transition-colors">
            <span className="text-accent shrink-0"><ChevronRight size={18} /></span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="BTC/USD testing weekly resistance..."
              className="bg-transparent border-none outline-none flex-grow text-chrome placeholder-gray-800 w-full font-light"
              disabled={loading}
            />
          </form>
        </div>

        {loading && (
          <div className="flex items-center gap-3 text-accent animate-pulse py-2">
            <Loader2 className="animate-spin" size={16} />
            <span className="text-[10px] md:text-xs uppercase tracking-[0.2em]">CALCULATING INSTITUTIONAL FLOW...</span>
          </div>
        )}

        {error && (
          <div className="text-red-500 border border-red-900/40 bg-red-950/10 p-4 text-[10px] md:text-xs">
            [FATAL_ERROR] {error}
          </div>
        )}

        {analysis && !loading && (
          <div className="space-y-6 md:space-y-8 animate-in fade-in slide-in-from-bottom-3 duration-700">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
              <div className="border border-white/10 p-5 md:p-6 bg-white/[0.02]">
                <span className="text-[9px] text-gray-600 uppercase block mb-2 tracking-[0.2em]">Bias Assessment</span>
                <span className={`text-2xl md:text-4xl font-syncopate font-bold ${
                  analysis.bias === 'BULLISH' ? 'text-green-500' : 
                  analysis.bias === 'BEARISH' ? 'text-red-500' : 'text-gray-400'
                }`}>
                  {analysis.bias}
                </span>
                <div className="mt-4 h-1 bg-white/5 w-full">
                  <div className="h-full bg-accent transition-all duration-1000 shadow-[0_0_10px_rgba(0,240,255,0.5)]" style={{ width: `${analysis.confidence}%` }}></div>
                </div>
                <span className="text-[9px] text-gray-600 mt-2 block tracking-widest uppercase font-bold">CONFIDENCE: {analysis.confidence}%</span>
              </div>

              <div className="border border-white/10 p-5 md:p-6 space-y-3 bg-white/[0.02]">
                <span className="text-[9px] text-gray-600 uppercase block mb-2 tracking-[0.2em]">Tactical Levels</span>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-[10px] text-gray-500 uppercase">ENTRY</span>
                  <span className="text-chrome text-[11px] md:text-[12px] font-bold tracking-wider">{analysis.levels.entry}</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-[10px] text-gray-500 uppercase">STOP</span>
                  <span className="text-chrome text-[11px] md:text-[12px] font-bold tracking-wider">{analysis.levels.stop}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-[10px] text-gray-500 uppercase">TARGET</span>
                  <span className="text-chrome text-[11px] md:text-[12px] font-bold tracking-wider">{analysis.levels.target}</span>
                </div>
              </div>
            </div>

            <div className="border border-white/10 p-5 md:p-6 bg-white/[0.02]">
              <span className="text-[9px] text-gray-600 uppercase block mb-3 tracking-[0.2em]">Institutional Reasoning</span>
              <p className="text-xs md:text-sm leading-relaxed text-gray-400 font-light italic">
                {analysis.reasoning}
              </p>
            </div>
            
            <button 
              onClick={() => setAnalysis(null)} 
              className="text-[9px] md:text-[10px] text-accent/60 hover:text-accent flex items-center gap-2 uppercase tracking-[0.3em] font-bold transition-colors"
            >
              <Zap size={12} /> RE-INITIALIZE_SYSTEM
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Terminal;
