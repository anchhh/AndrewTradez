
import React, { useState, useEffect, useRef } from 'react';
import { 
  ChevronLeft, 
  ChevronRight, 
  Settings, 
  Upload, 
  RotateCcw,
  Maximize2,
  Plus,
  Trash2,
  Info
} from 'lucide-react';

interface ResultItem {
  type: 'PAYOUT' | 'TRADE' | 'TESTIMONIAL';
  user: string;
  date: string;
  title: string;
  content: string;
  stats: string;
  image: string;
  fit?: 'cover' | 'contain';
}

const DEFAULT_RESULTS: ResultItem[] = [
  {
    type: 'PAYOUT',
    user: 'colossalpeanut',
    date: '12/24/25, 9:12 PM',
    title: 'PAYOUT_BATCH_VERIFIED',
    content: 'Hi Matthew, Congratulations! Your payout request has been approved for MFFUSFCRFLX210887027. "Some payouts from this year 🔥". Verified institutional performance.',
    stats: 'BATCH: $15,497.82',
    image: 'https://images.unsplash.com/photo-1554224155-1696413575b3?auto=format&fit=crop&q=80&w=1200',
    fit: 'contain'
  },
  {
    type: 'TRADE',
    user: 'adumi',
    date: '8/4/25',
    title: 'BTC/USD INSTITUTIONAL RUN',
    content: 'Precision long capture on BTC. "Real profit is 1/2 of this" — capture during liquidity expansion.',
    stats: 'P/L: +$70,900.00',
    image: 'https://images.unsplash.com/photo-1611974717482-48a0053d4fdc?auto=format&fit=crop&q=80&w=1200',
    fit: 'cover'
  },
  {
    type: 'TESTIMONIAL',
    user: 'miniturepeanut',
    date: '2/4/25',
    title: 'LIFE CHANGING SKILL SET',
    content: '"Andrew will take you step by step... he\'s the dude to go to. You\'ll receive a life changing skill set. 👑 🐐"',
    stats: 'RATING: 5/5',
    image: 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80&w=1200',
    fit: 'cover'
  }
];

const ResultsSlideshow: React.FC = () => {
  const [results, setResults] = useState<ResultItem[]>(() => {
    const saved = localStorage.getItem('mercury_slides');
    return saved ? JSON.parse(saved) : DEFAULT_RESULTS;
  });
  
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isAdminMode, setIsAdminMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const next = () => setCurrentIndex((prev) => (prev + 1) % results.length);
  const prev = () => setCurrentIndex((prev) => (prev - 1 + results.length) % results.length);

  useEffect(() => {
    if (isPaused || isAdminMode) return;
    const interval = setInterval(next, 8000);
    return () => clearInterval(interval);
  }, [isPaused, isAdminMode, results.length]);

  const saveResults = (newResults: ResultItem[]) => {
    setResults(newResults);
    localStorage.setItem('mercury_slides', JSON.stringify(newResults));
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        const newResults = [...results];
        newResults[currentIndex] = { 
          ...newResults[currentIndex], 
          image: base64String,
          fit: 'contain'
        };
        saveResults(newResults);
      };
      reader.readAsDataURL(file);
    }
  };

  const toggleFit = () => {
    const newResults = [...results];
    newResults[currentIndex].fit = newResults[currentIndex].fit === 'contain' ? 'cover' : 'contain';
    saveResults(newResults);
  };

  const addSlide = () => {
    const newSlide: ResultItem = {
      type: 'PAYOUT',
      user: 'new_user',
      date: 'TODAY',
      title: 'NEW_IMAGE',
      content: '',
      stats: '',
      image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&q=80&w=1200',
      fit: 'cover'
    };
    const newResults = [...results, newSlide];
    saveResults(newResults);
    setCurrentIndex(newResults.length - 1);
  };

  const deleteSlide = () => {
    if (results.length <= 1) return;
    const newResults = results.filter((_, i) => i !== currentIndex);
    saveResults(newResults);
    setCurrentIndex(0);
  };

  const resetToDefaults = () => {
    if (confirm('Restore institutional defaults?')) {
      saveResults(DEFAULT_RESULTS);
      setCurrentIndex(0);
    }
  };

  return (
    <div 
      className="relative w-full max-w-6xl mx-auto group touch-pan-y"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      {/* Admin Controls Area */}
      <div className="absolute top-2 right-2 md:top-4 md:right-4 z-40 flex flex-col items-end gap-2">
        <button 
          onClick={() => setIsAdminMode(!isAdminMode)}
          className={`flex items-center gap-2 px-3 py-2 ${isAdminMode ? 'bg-accent text-dark' : 'bg-white/10 text-white'} text-[9px] md:text-[10px] font-bold font-syncopate hover:bg-accent hover:text-dark transition-all shadow-lg backdrop-blur-md border border-white/10`}
        >
          <Settings size={10} className={isAdminMode ? 'animate-spin' : ''} />
          {isAdminMode ? 'CLOSE_EDITOR' : 'MANAGE'}
        </button>

        {isAdminMode && (
          <div className="flex flex-wrap justify-end gap-2 animate-in slide-in-from-right-4 duration-300">
             <button 
              onClick={addSlide}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-green-500/80 text-white text-[8px] md:text-[10px] font-bold font-syncopate hover:bg-green-600 transition-all shadow-lg backdrop-blur-md"
            >
              <Plus size={10} /> ADD
            </button>
            <button 
              onClick={deleteSlide}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-red-500/80 text-white text-[8px] md:text-[10px] font-bold font-syncopate hover:bg-red-600 transition-all shadow-lg backdrop-blur-md"
            >
              <Trash2 size={10} /> DELETE
            </button>
            <button 
              onClick={toggleFit}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-white/10 text-white text-[8px] md:text-[10px] font-bold font-syncopate hover:bg-accent hover:text-dark transition-all shadow-lg backdrop-blur-md border border-white/10"
            >
              <Maximize2 size={10} /> {results[currentIndex].fit === 'contain' ? 'COVER' : 'AS_IS'}
            </button>
            <button 
              onClick={resetToDefaults}
              className="flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-orange-500/80 text-white text-[8px] md:text-[10px] font-bold font-syncopate hover:bg-orange-600 transition-all shadow-lg"
            >
              <RotateCcw size={10} /> RESET
            </button>
          </div>
        )}
      </div>

      <div className="relative overflow-hidden aspect-[4/5] md:aspect-[21/9] border border-white/10 glass-card bg-black/60 shadow-inner">
        {results.map((item, idx) => (
          <div
            key={idx}
            className={`absolute inset-0 transition-all duration-700 ease-out flex items-center justify-center ${
              idx === currentIndex ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-12 pointer-events-none'
            }`}
          >
            {/* Ambient Background Aura */}
            {item.fit === 'contain' && (
              <div 
                className="absolute inset-0 z-0 opacity-20 filter blur-3xl scale-125"
                style={{ 
                  backgroundImage: `url(${item.image})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              />
            )}
            
            <img 
              src={item.image} 
              alt={`Slide ${idx + 1}`} 
              className={`w-full h-full z-0 transition-transform duration-[10s] ${
                item.fit === 'contain' ? 'object-contain px-4 py-4 md:px-8 md:py-8' : 'object-cover filter brightness-[0.85]'
              } ${idx === currentIndex && item.fit !== 'contain' ? 'scale-105' : ''}`}
            />
            
            {isAdminMode && idx === currentIndex && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-dark/60 backdrop-blur-sm">
                <div className="text-center p-6 md:p-8 border border-accent/20 bg-dark/80 relative mx-4">
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept="image/*"
                    onChange={handleImageUpload}
                  />
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center gap-3 md:gap-4 group/upload"
                  >
                    <div className="p-4 md:p-6 rounded-full bg-accent/10 border border-accent text-accent group-hover/upload:scale-110 transition-transform">
                      <Upload size={24} className="md:w-[32px] md:h-[32px]" />
                    </div>
                    <div className="font-syncopate text-[9px] md:text-xs tracking-widest text-white uppercase">UPLOAD_REPLACEMENT</div>
                    <div className="text-[8px] text-gray-500 font-mono italic">Visual verification only.</div>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Navigation Buttons - More accessible on mobile */}
        <button 
          onClick={prev}
          className="absolute left-2 md:left-6 top-1/2 -translate-y-1/2 z-30 p-2 md:p-4 bg-dark/60 border border-white/10 text-white hover:bg-accent hover:text-dark transition-all backdrop-blur-md active:scale-95"
          aria-label="Previous Slide"
        >
          <ChevronLeft size={20} className="md:w-[24px] md:h-[24px]" />
        </button>
        <button 
          onClick={next}
          className="absolute right-2 md:right-6 top-1/2 -translate-y-1/2 z-30 p-2 md:p-4 bg-dark/60 border border-white/10 text-white hover:bg-accent hover:text-dark transition-all backdrop-blur-md active:scale-95"
          aria-label="Next Slide"
        >
          <ChevronRight size={20} className="md:w-[24px] md:h-[24px]" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 md:gap-2 mt-8 md:mt-12 justify-center px-4">
        {results.map((_, idx) => (
          <button
            key={idx}
            onClick={() => setCurrentIndex(idx)}
            className={`group relative h-[3px] md:h-[4px] transition-all duration-500 overflow-hidden ${
              idx === currentIndex ? 'w-10 md:w-24 bg-white/10' : 'w-2 md:w-6 bg-white/5'
            }`}
          >
            {idx === currentIndex && (
              <div 
                className="absolute inset-0 bg-accent origin-left"
                style={{ animation: `progress ${isPaused ? '0s' : '8s'} linear forwards` }}
              />
            )}
          </button>
        ))}
      </div>

      <style>{`
        @keyframes progress {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }
      `}</style>
    </div>
  );
};

export default ResultsSlideshow;
