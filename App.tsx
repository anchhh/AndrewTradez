import React, { useEffect, useState } from 'react';
import LiquidBackground from './components/LiquidBackground';
import ResultsSlideshow from './components/ResultsSlideshow';
import VideoSlideshow from './components/VideoSlideshow';
import EnrollmentEmbed from './components/EnrollmentEmbed';
import TermsModal from './components/TermsModal';
import { 
  Menu, 
  X, 
  ArrowUpRight, 
  TrendingUp, 
  Shield, 
  Users, 
  MessageSquare, 
  Zap,
  Smartphone,
  Infinity,
  Calendar,
  Library,
  Edit3,
  UserPlus
} from 'lucide-react';

const App: React.FC = () => {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showEnrollment, setShowEnrollment] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const triggerEnrollment = () => {
    setShowEnrollment(true);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen font-mono text-chrome bg-dark selection:bg-accent selection:text-dark overflow-x-hidden">
      <LiquidBackground />

      {/* Navigation */}
      <nav className={`fixed top-0 w-full z-50 transition-all duration-500 ${isScrolled ? 'bg-dark/90 backdrop-blur-xl border-b border-white/5' : 'bg-transparent'}`}>
        <div className="max-w-7xl mx-auto px-5 md:px-8 h-16 md:h-24 flex items-center justify-between">
          <div className="font-syncopate text-sm md:text-lg font-bold tracking-tighter hover:text-accent transition-colors cursor-pointer uppercase">
            MASTER THE MARKETS
          </div>
          
          <div className="hidden md:flex gap-12 text-[10px] uppercase tracking-[0.2em] font-medium">
            <button 
              onClick={triggerEnrollment}
              className="hover:text-accent transition-colors font-bold tracking-[0.3em]"
            >
              JOIN CIRCLE
            </button>
          </div>

          <button 
            className="md:hidden text-chrome p-2 -mr-2"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle Menu"
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </nav>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[60] bg-dark/98 backdrop-blur-2xl flex flex-col items-center justify-center gap-10 text-lg font-syncopate uppercase tracking-[0.3em] animate-in fade-in zoom-in duration-300 text-center px-6">
          <div className="text-accent text-xs mb-8 tracking-[0.5em] font-bold">MASTER THE MARKETS</div>
          <button onClick={triggerEnrollment} className="hover:text-accent">Join Circle</button>
          <button 
            className="mt-12 px-10 py-4 border border-accent/30 text-accent text-[10px] font-bold tracking-widest"
            onClick={() => setMobileMenuOpen(false)}
          >
            CLOSE_SYSTEM
          </button>
        </div>
      )}

      {/* Enrollment Popup Component */}
      <EnrollmentEmbed 
        isOpen={showEnrollment} 
        onClose={() => setShowEnrollment(false)} 
      />

      {/* Legal/Terms Modal */}
      <TermsModal 
        isOpen={showTerms} 
        onClose={() => setShowTerms(false)} 
      />

      <main className="relative z-10 pt-28 md:pt-60 px-5 md:px-8">
        {/* Hero Section */}
        <section className="max-w-7xl mx-auto mb-20 md:mb-24">
          <div className="overflow-hidden mb-6 md:mb-10">
            <h1 className="text-[clamp(2.2rem,12vw,10rem)] font-syncopate font-bold leading-[1.1] md:leading-[0.85] tracking-tighter bg-gradient-to-b from-white via-chrome to-gray-700 bg-clip-text text-transparent drop-shadow-2xl text-center md:text-left">
              PIECE OF<br className="md:block" /> THE PIE
            </h1>
          </div>
          
          <div className="grid md:grid-cols-2 items-end gap-10 md:gap-16">
            <div className="max-w-md space-y-5 md:space-y-8 text-center md:text-left mx-auto md:mx-0">
              <div className="flex items-center justify-center md:justify-start gap-3 text-accent text-[8px] md:text-[10px] tracking-[0.4em] font-bold uppercase">
                <span className="w-6 md:w-10 h-[1px] bg-accent/50"></span>
                ANDREWTRADEZ TRADING MODEL
              </div>
              <p className="text-gray-400 text-xs md:text-base leading-relaxed font-light">
                Master the definitive framework that empowered me—and countless others—to transcend financial struggle and finally achieve the lifestyle of our dreams.
              </p>
            </div>
            <div className="flex justify-center md:justify-end">
              <button 
                onClick={triggerEnrollment}
                className="w-full md:w-auto px-10 py-5 bg-white text-dark font-syncopate font-bold text-[10px] md:text-xs tracking-widest hover:bg-accent hover:shadow-[0_0_40px_rgba(0,240,255,0.5)] hover:-skew-x-6 transition-all duration-500 uppercase active:scale-95"
              >
                INITIATE ENROLLMENT
              </button>
            </div>
          </div>
        </section>

        {/* Discord Section */}
        <section className="max-w-7xl mx-auto mb-20 md:mb-32">
          <div className="relative overflow-hidden p-8 md:p-12 border border-accent/20 bg-accent/5 backdrop-blur-sm group hover:border-accent/40 transition-all duration-500">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <MessageSquare size={120} className="text-accent" />
            </div>
            <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8 text-center md:text-left">
              <div className="max-w-2xl">
                <div className="flex items-center justify-center md:justify-start gap-3 text-accent text-[9px] font-bold tracking-[0.5em] mb-4">
                  <Zap size={14} fill="currentColor" />
                  FREE ACCESS PROTOCOL
                </div>
                <h2 className="text-2xl md:text-4xl font-syncopate font-bold mb-4 uppercase tracking-tighter">THE INNER CIRCLE</h2>
                <p className="text-gray-400 text-xs md:text-base font-light leading-relaxed">
                  Join 1,000+ traders in my FREE Discord. Get daily trade recaps, Trading chat rooms, and connect with the 1% for absolutely zero cost.
                </p>
              </div>
              <a 
                href="https://whop.com/andrewtradez/?a=andrewtradezz" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group flex items-center gap-4 px-8 py-5 border border-accent/30 hover:border-accent hover:bg-accent hover:text-dark transition-all duration-500 font-syncopate font-bold text-[10px] tracking-widest uppercase"
              >
                JOIN THE DISCORD
                <ArrowUpRight size={18} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
              </a>
            </div>
          </div>
        </section>

        {/* Video Testimonials Section */}
        <section id="students" className="max-w-7xl mx-auto mb-20 md:mb-40 py-12 md:py-24 border-b border-white/5">
          <div className="text-center mb-10 md:mb-20">
            <h2 className="text-2xl md:text-4xl font-syncopate font-bold mb-2 md:mb-4 uppercase tracking-tighter">HEAR FROM THE STUDENTS</h2>
          </div>
          <VideoSlideshow />
        </section>

        {/* Results Section */}
        <section id="alpha" className="max-w-7xl mx-auto mb-20 md:mb-40 py-12 md:py-24 bg-white/[0.02] border-y border-white/5">
          <div className="text-center mb-10 md:mb-20">
            <h2 className="text-2xl md:text-4xl font-syncopate font-bold mb-2 md:mb-4 uppercase tracking-tighter">THE PERFORMANCE</h2>
          </div>
          <ResultsSlideshow />
        </section>

        {/* Quantitative Edge Stats */}
        <section className="max-w-7xl mx-auto mb-24 md:mb-52">
          <div className="grid grid-cols-1 md:grid-cols-3 border border-white/5 bg-black/40 backdrop-blur-sm">
            <div className="p-10 md:p-14 glass-card hover:bg-white/5 transition-colors border-b md:border-b-0 md:border-r border-white/5 group text-center md:text-left">
              <TrendingUp className="text-accent mb-5 md:mb-8 opacity-40 group-hover:opacity-100 transition-opacity mx-auto md:mx-0" size={32} />
              <span className="block text-4xl md:text-5xl font-syncopate font-bold mb-3">74.2%</span>
              <span className="text-[9px] md:text-[11px] text-gray-500 uppercase tracking-[0.3em]">Verified Win Rate</span>
              <p className="mt-5 text-[10px] md:text-xs text-gray-600 font-mono">Verified across multiple cycles.</p>
            </div>
            <div className="p-10 md:p-14 glass-card hover:bg-white/5 transition-colors border-b md:border-b-0 md:border-r border-white/5 group text-center md:text-left">
              <Shield className="text-accent mb-5 md:mb-8 opacity-40 group-hover:opacity-100 transition-opacity mx-auto md:mx-0" size={32} />
              <span className="block text-4xl md:text-5xl font-syncopate font-bold mb-3">1:2.6</span>
              <span className="text-[9px] md:text-[11px] text-gray-500 uppercase tracking-[0.3em]">Risk/Reward Avg</span>
              <p className="mt-5 text-[10px] md:text-xs text-gray-600 font-mono">Asymmetric edge optimization.</p>
            </div>
            <div className="p-10 md:p-14 glass-card hover:bg-white/5 transition-colors group text-center md:text-left">
              <Users className="text-accent mb-5 md:mb-8 opacity-40 group-hover:opacity-100 transition-opacity mx-auto md:mx-0" size={32} />
              <span className="block text-4xl md:text-5xl font-syncopate font-bold mb-3">12/15</span>
              <span className="text-[9px] md:text-[11px] text-gray-500 uppercase tracking-[0.3em]">Seats Remaining</span>
              <p className="mt-5 text-[10px] md:text-xs text-gray-600 font-mono">Exclusive intake window active.</p>
            </div>
          </div>
        </section>

        {/* What's Included Section */}
        <section className="max-w-7xl mx-auto mb-28 md:mb-52 py-16 md:py-32">
          <div className="text-center mb-16 md:mb-24">
            <h2 className="text-3xl md:text-6xl font-syncopate font-bold mb-4 md:mb-8 uppercase tracking-tighter">THE UTILITIES</h2>
            <p className="text-accent text-[8px] md:text-xs tracking-[0.5em] uppercase font-bold">EXCLUSIVE 1-ON-1 WEEKLY SCHEDULE + INCLUSIONS</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
            {[
              {
                icon: <Smartphone size={24} />,
                title: "DIRECT LINE ACCESS",
                desc: "Immediate access to Andrew's personal cellular line for rapid-response market queries and guidance."
              },
              {
                icon: <Infinity size={24} />,
                title: "PERPETUAL MEMBERSHIP",
                desc: "LIFETIME Access to the Exclusive Circle and high-tier 1-on-1 Mentorship protocol."
              },
              {
                icon: <UserPlus size={24} />,
                title: "TACTICAL OPERATIONS HUB",
                desc: "Full entry into the private 1-on-1 groupchat for real-time market synergy and professional networking."
              },
              {
                icon: <Calendar size={24} />,
                title: "PEAK FREQUENCY SESSIONS",
                desc: "5 dedicated 1-on-1 sessions weekly (Mon - Fri) at whatever time window suits your global schedule."
              },
              {
                icon: <Library size={24} />,
                title: "THE INTEL REPOSITORY",
                desc: "300+ hours of recorded classes, institutional trade recaps, and live backtesting streams."
              },
              {
                icon: <Edit3 size={24} />,
                title: "STRATEGIC DRILLS",
                desc: "Daily and weekly customized homework and assignments to solidify technical mastery and neural discipline."
              }
            ].map((item, idx) => (
              <div key={idx} className="p-8 md:p-10 border border-white/5 bg-white/[0.02] glass-card hover:border-accent/40 hover:bg-accent/5 transition-all duration-500 group">
                <div className="w-12 h-12 flex items-center justify-center border border-accent/20 bg-accent/5 text-accent mb-8 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(0,240,255,0.2)] transition-all">
                  {item.icon}
                </div>
                <h3 className="font-syncopate text-sm md:text-base font-bold mb-4 tracking-tighter uppercase">{item.title}</h3>
                <p className="text-gray-500 text-xs leading-relaxed font-light">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Approach Section */}
        <section id="method" className="max-w-7xl mx-auto mb-28 md:mb-60">
          <div className="mb-14 md:mb-24 text-center md:text-left">
            <h2 className="text-3xl md:text-6xl font-syncopate font-bold mb-4 md:mb-8 leading-tight">THE<br className="hidden md:block" /> APPROACH</h2>
            <p className="text-gray-500 max-w-sm mx-auto md:mx-0 text-xs md:text-base font-light">
              A modular approach to market mastery, focusing on smart money concepts and a deep understanding of price action to unlock consistent institutional-grade profitability.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
            {[
              { 
                id: '01', 
                title: 'The Basics', 
                desc: 'Laying the foundation. Assessing your current market knowledge and aligning your mindset with institutional frameworks to ensure a professional start.' 
              },
              { 
                id: '02', 
                title: 'Neural Discipline', 
                desc: 'The psychological framework of elite performance. Remove the biological bias from technical execution and develop the iron mindset of the 1%.' 
              },
              { 
                id: '03', 
                title: 'Perfecting Model', 
                desc: 'Refining execution. Mastering the "Piece of the Pie" strategy to start extracting consistent profits and documenting professional-grade results.' 
              },
            ].map((item, idx) => (
              <div 
                key={idx} 
                className={`p-10 md:p-14 glass-card border-t-2 border-white/5 hover:border-accent transition-all duration-700 group ${idx === 1 ? 'md:mt-24' : ''}`}
              >
                <span className="block font-syncopate text-[10px] md:text-xs text-accent mb-8 md:mb-12 opacity-40">{item.id}</span>
                <h3 className="text-2xl md:text-3xl font-syncopate font-bold mb-6 md:mb-8 group-hover:translate-x-3 transition-transform duration-500 uppercase">{item.title}</h3>
                <p className="text-gray-400 text-xs md:text-sm leading-relaxed font-light">{item.desc}</p>
                <div className="mt-10 md:mt-12 flex justify-end">
                   <ArrowUpRight className="text-white/10 group-hover:text-accent group-hover:rotate-45 transition-all duration-500" size={24} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA Banner */}
        <section id="enroll" className="max-w-7xl mx-auto mb-20 md:mb-40 bg-white text-dark py-20 md:py-32 px-6 md:px-16 flex flex-col items-center text-center">
          <h2 className="text-3xl md:text-7xl font-syncopate font-bold mb-8 md:mb-10 uppercase tracking-tighter leading-none">BECOME THE 1%</h2>
          <div className="max-w-xl mb-12 md:mb-16 font-mono text-[10px] md:text-xs uppercase tracking-[0.4em] text-dark/60 italic">
            SEATS OPEN: <br className="md:hidden" />
            <span className="font-bold text-dark text-base md:text-lg block mt-2 not-italic">12/15 SEATS AVAILABLE</span>
          </div>
          
          <button 
            onClick={triggerEnrollment}
            className="w-full md:w-auto px-12 md:px-16 py-6 md:py-8 bg-dark text-white font-syncopate font-bold text-xs md:text-sm tracking-[0.3em] hover:scale-105 active:scale-95 transition-all uppercase"
          >
            APPLY FOR ACCESS
          </button>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12 md:py-20 px-5 md:px-8 bg-black/60 backdrop-blur-md">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-10">
          <div className="text-[8px] md:text-[10px] text-gray-600 uppercase tracking-[0.4em] text-center md:text-left">
            &copy; 2025 ANDREWTRADEZ PIECE OF THE PIE. ALL RIGHTS RESERVED.
          </div>
          <div className="flex flex-wrap justify-center gap-8 md:gap-12 text-[8px] md:text-[10px] text-gray-500 uppercase tracking-[0.3em]">
            <button onClick={() => setShowTerms(true)} className="hover:text-accent transition-colors">Terms</button>
            <button onClick={() => setShowTerms(true)} className="hover:text-accent transition-colors">Risk Disclosure</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;