import { useState, useRef, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { Send, Zap, User as UserIcon, Bot, Trash2, AlertCircle, Image as ImageIcon, X, LogIn, LogOut, Plus, MessageSquare, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { getChat } from './lib/gemini';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  doc, 
  setDoc, 
  getDoc,
  updateDoc,
  deleteDoc,
  type User 
} from './lib/firebase';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  role: 'user' | 'model';
  content: string;
  image?: string;
  photoURL?: string;
  timestamp?: any;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong. Please try again later.";
      try {
        const parsedError = JSON.parse(this.state.error?.message || "");
        if (parsedError.error && parsedError.error.includes("Missing or insufficient permissions")) {
          errorMessage = "You don't have permission to perform this action. Please check your account.";
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen bg-scream-bg flex flex-col items-center justify-center p-4 text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
          <h1 className="text-2xl font-black text-white mb-2 uppercase italic">System Error</h1>
          <p className="text-scream-muted mb-6 max-w-md font-mono text-sm">{errorMessage}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-scream-accent text-scream-bg font-black uppercase tracking-widest hover:scale-105 transition-all"
          >
            Restart System
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function ChatApp() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [chats, setChats] = useState<any[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const chatRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Sync user profile
        const userDocRef = doc(db, 'users', currentUser.uid);
        try {
          const userDoc = await getDoc(userDocRef);
          if (!userDoc.exists()) {
            await setDoc(userDocRef, {
              uid: currentUser.uid,
              email: currentUser.email,
              displayName: currentUser.displayName,
              photoURL: currentUser.photoURL,
              isAdmin: currentUser.email === 'sudemgulbahce@gmail.com'
            });
          }
          setIsAdmin(userDoc.data()?.isAdmin || currentUser.email === 'sudemgulbahce@gmail.com');
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
        }
      } else {
        setIsAdmin(false);
        setMessages([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    chatRef.current = getChat(isAdmin);
  }, [isAdmin, currentChatId]); // Reset AI session when chat changes to avoid cross-chat memory leaks

  useEffect(() => {
    console.log("ScreamAI initialized. User:", user?.email, "Admin:", isAdmin);
  }, [user, isAdmin]);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setCurrentChatId(null);
      return;
    }

    const chatsQuery = query(
      collection(db, 'users', user.uid, 'chats'),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(chatsQuery, (snapshot) => {
      const newChats = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setChats(newChats);
      
      // If no chat is selected and we have chats, select the most recent one
      if (!currentChatId && newChats.length > 0) {
        setCurrentChatId(newChats[0].id);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/chats`);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user) {
      setMessages([]);
      return;
    }
    
    if (!currentChatId) {
      // Only clear messages if we are truly in a "no chat selected" state
      // and not in the middle of creating one
      if (chats.length > 0) setMessages([]);
      return;
    }

    const messagesQuery = query(
      collection(db, 'users', user.uid, 'chats', currentChatId, 'messages'),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(messagesQuery, (snapshot) => {
      const newMessages = snapshot.docs.map(doc => doc.data() as Message);
      if (newMessages.length > 0) {
        setMessages(newMessages);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/chats/${currentChatId}/messages`);
    });

    return () => unsubscribe();
  }, [user, currentChatId, chats.length]);

  const createNewChat = () => {
    setCurrentChatId(null);
    setMessages([]);
    chatRef.current = getChat(isAdmin);
    if (window.innerWidth < 1024) setIsSidebarOpen(false);
  };

  const deleteChat = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'chats', chatId));
      if (currentChatId === chatId) {
        setCurrentChatId(null);
        setMessages([]);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/chats/${chatId}`);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error('Login error:', err);
      setError('Login failed. Mirza abim, Google girişi yapılamadı.');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setSelectedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && !selectedImage) || isLoading) return;

    let activeChatIdForAI = currentChatId;
    const currentInput = input;
    const currentImage = selectedImage;

    if (currentInput.trim().toLowerCase() === 'bukimtr') {
      setIsAdmin(true);
      setInput('');
      const adminWelcome: Message = { 
        role: 'model', 
        content: 'Sistem tanındı. Hoş geldin Mirza abim! 🫡👑 Senin geliştirdiğin bu zekâ artık emrinde. Ne yapmamı istersin? ⚡🚀',
        timestamp: new Date()
      };
      
      if (!user) {
        setMessages((prev) => [...prev, { role: 'user', content: 'bukimtr', timestamp: new Date() }, adminWelcome]);
      } else {
        try {
          let activeChatId = currentChatId;
          if (!activeChatId) {
            const chatData = {
              title: 'Admin Mode Activation',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            };
            const chatDocRef = await addDoc(collection(db, 'users', user.uid, 'chats'), chatData);
            activeChatId = chatDocRef.id;
            setCurrentChatId(activeChatId);
          }
          
          await addDoc(collection(db, 'users', user.uid, 'chats', activeChatId, 'messages'), {
            role: 'user',
            content: 'bukimtr',
            timestamp: serverTimestamp()
          });
          await addDoc(collection(db, 'users', user.uid, 'chats', activeChatId, 'messages'), {
            ...adminWelcome,
            timestamp: serverTimestamp()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/chats/${currentChatId || 'new'}/messages`);
        }
      }
      return;
    }

    const userMessage: Message = { 
      role: 'user', 
      content: currentInput,
      photoURL: user?.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.uid || 'guest'}`,
      timestamp: new Date()
    };
    
    if (currentImage) {
      userMessage.image = currentImage;
    }
    
    // Optimistic update
    setMessages((prev) => [...prev, userMessage]);
    
    setInput('');
    setSelectedImage(null);
    setIsLoading(true);
    setError(null);

    if (user) {
      try {
        let activeChatId = currentChatId;
        if (!activeChatId) {
          const chatData = {
            title: currentInput.slice(0, 30) || 'Yeni Sohbet',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          const chatDocRef = await addDoc(collection(db, 'users', user.uid, 'chats'), chatData);
          activeChatId = chatDocRef.id;
          setCurrentChatId(activeChatId);
        } else {
          await updateDoc(doc(db, 'users', user.uid, 'chats', activeChatId), {
            updatedAt: serverTimestamp()
          });
        }

        const messageToSave: any = {
          role: userMessage.role,
          content: userMessage.content,
          photoURL: userMessage.photoURL,
          timestamp: serverTimestamp()
        };
        if (userMessage.image) messageToSave.image = userMessage.image;

        await addDoc(collection(db, 'users', user.uid, 'chats', activeChatId, 'messages'), messageToSave);
        
        activeChatIdForAI = activeChatId;
      } catch (err) {
        console.error("Firestore save error:", err);
        // Don't throw here, let AI try to respond even if save fails
      }
    }

    try {
      if (!chatRef.current) {
        chatRef.current = getChat(isAdmin);
      }
      
      let response;
      if (currentImage) {
        const base64Data = currentImage.split(',')[1];
        const mimeType = currentImage.split(';')[0].split(':')[1];
        
        response = await chatRef.current.sendMessage({
          message: {
            parts: [
              { text: currentInput || "Bu görseli analiz et." },
              { inlineData: { data: base64Data, mimeType } }
            ]
          }
        });
      } else {
        response = await chatRef.current.sendMessage({ message: currentInput });
      }
      
      if (!response || !response.text) {
        throw new Error("AI returned an empty response.");
      }
      
      const modelMessage: Message = { 
        role: 'model', 
        content: response.text,
        timestamp: new Date()
      };

      if (!user) {
        setMessages((prev) => [...prev, modelMessage]);
      } else {
        const finalChatId = activeChatIdForAI || currentChatId;
        if (finalChatId) {
          await addDoc(collection(db, 'users', user.uid, 'chats', finalChatId, 'messages'), {
            ...modelMessage,
            timestamp: serverTimestamp()
          });
        }
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      setError(`AI Error: ${err.message || 'Connection failed'}`);
      
      const errorMsg = `AI Error: ${err.message || 'Connection failed'}. Lütfen tekrar dene Mirza abim.`;
      if (!user) {
        setMessages((prev) => [...prev, { role: 'model', content: errorMsg, timestamp: new Date() }]);
      } else {
        const finalChatId = activeChatIdForAI || currentChatId;
        if (finalChatId) {
          addDoc(collection(db, 'users', user.uid, 'chats', finalChatId, 'messages'), {
            role: 'model',
            content: errorMsg,
            timestamp: serverTimestamp()
          }).catch(e => console.error("Failed to save error:", e));
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = async () => {
    if (!user) {
      setMessages([]);
    } else {
      setMessages([]);
    }
    chatRef.current = getChat(isAdmin);
  };

  return (
    <div className="h-screen bg-scream-bg text-scream-ink flex font-sans selection:bg-scream-accent selection:text-scream-bg overscroll-none overflow-hidden">
      {/* Sidebar */}
      <AnimatePresence>
        {(isSidebarOpen || (window.innerWidth > 1024)) && (
          <motion.aside
            initial={{ x: -300 }}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            className={cn(
              "fixed lg:relative z-40 w-72 h-full bg-black border-r-2 border-scream-accent flex flex-col transition-all duration-300",
              !isSidebarOpen && "hidden lg:flex"
            )}
          >
            <div className="p-4 border-b-2 border-scream-accent flex justify-between items-center">
              <h2 className="font-black uppercase tracking-widest text-sm">Sohbetler</h2>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="lg:hidden p-1 hover:text-scream-accent"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4">
              <button 
                onClick={createNewChat}
                className="w-full p-3 border-2 border-scream-accent flex items-center justify-center gap-2 font-black uppercase tracking-tighter hover:bg-scream-accent hover:text-black transition-all group"
              >
                <Plus className="w-5 h-5 group-hover:rotate-90 transition-transform" />
                Yeni Sohbet
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  onClick={() => {
                    setCurrentChatId(chat.id);
                    setIsSidebarOpen(false);
                  }}
                  className={cn(
                    "p-3 flex items-center justify-between group cursor-pointer border-2 border-transparent transition-all",
                    currentChatId === chat.id 
                      ? "border-scream-accent bg-scream-accent/10" 
                      : "hover:bg-scream-muted/30"
                  )}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <MessageSquare className={cn(
                      "w-4 h-4 shrink-0",
                      currentChatId === chat.id ? "text-scream-accent" : "text-scream-muted"
                    )} />
                    <span className="text-xs font-bold uppercase tracking-tight truncate">
                      {chat.title}
                    </span>
                  </div>
                  <button 
                    onClick={(e) => deleteChat(chat.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-scream-accent transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {user && chats.length === 0 && (
                <p className="text-[10px] text-center font-mono opacity-40 mt-8">Henüz sohbet yok.</p>
              )}
              {!user && (
                <div className="p-4 text-center space-y-4">
                  <p className="text-[10px] font-mono opacity-40">Sohbet geçmişi için mail açın.</p>
                  <button 
                    onClick={handleLogin}
                    className="text-[10px] font-black uppercase tracking-widest text-scream-accent hover:underline"
                  >
                    Giriş Yap
                  </button>
                </div>
              )}
            </div>

            <div className="p-4 border-t-2 border-scream-accent bg-scream-muted/10">
              {user && (
                <div className="flex items-center gap-3">
                  <img src={user.photoURL || ""} alt="User" className="w-8 h-8 rounded-full border border-scream-accent" />
                  <div className="flex-1 overflow-hidden">
                    <p className="text-[10px] font-black uppercase truncate">{user.displayName}</p>
                    <p className="text-[8px] font-mono opacity-50 truncate">{user.email}</p>
                  </div>
                  <button onClick={handleLogout} className="p-1 hover:text-scream-accent">
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative h-full">
        {/* Header */}
        <header className="border-b-2 border-scream-accent p-4 sm:p-6 flex justify-between items-center bg-black sticky top-0 z-10 safe-pt">
          <div className="flex items-center gap-2 sm:gap-3">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="lg:hidden p-1 hover:text-scream-accent mr-2"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="relative">
              <Zap className="text-scream-accent w-6 h-6 sm:w-8 sm:h-8 fill-current" />
              <div className="absolute -top-1 -right-1 w-2 h-2 sm:w-3 sm:h-3 bg-white rotate-45 border border-black"></div>
            </div>
            <h1 className="text-xl sm:text-3xl font-black tracking-tighter uppercase italic logo-glitch">
              SCREAM<span className="text-scream-accent">AI</span>
              {isAdmin && <span className="text-[10px] sm:text-xs ml-2 text-white bg-scream-accent px-1 not-italic tracking-normal">ADMIN</span>}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {!user && (
              <button 
                onClick={handleLogin}
                className="p-2 border-2 border-scream-accent bg-scream-accent text-scream-bg hover:bg-transparent hover:text-scream-accent transition-all rounded-none group flex items-center gap-2"
                title="Login with Google"
              >
                <LogIn className="w-5 h-5 sm:w-6 sm:h-6" />
                <span className="text-[10px] font-black uppercase tracking-widest hidden sm:block">Login</span>
              </button>
            )}
            <button 
              onClick={createNewChat}
              className="p-2 border-2 border-transparent hover:border-scream-accent hover:bg-scream-accent hover:text-white transition-all rounded-none group"
              title="New Chat"
            >
              <Plus className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </header>

        {/* Chat Area */}
        <main 
          className="flex-1 overflow-y-auto p-4 space-y-4 sm:space-y-6 max-w-4xl mx-auto w-full scroll-smooth pb-32"
        >
          <div className="min-h-full flex flex-col">
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6 sm:space-y-8 py-8 sm:py-12">
            <div className="space-y-4">
              <Zap className="w-12 h-12 sm:w-16 sm:h-16 text-scream-accent mx-auto animate-pulse" />
              <div className="space-y-2">
                <p className="text-xl sm:text-2xl font-black uppercase tracking-[0.3em]">System Active</p>
                <p className="text-xs sm:text-sm font-mono opacity-50 italic">
                  {user ? `Sistem aktif, ${user.displayName}.` : 'İz bırakmaya hazır mısın?'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 w-full max-w-2xl">
              {[
                { id: 'game', label: 'Game Master', icon: '🎮', prompt: 'Design a dark strategy for a survival game.' },
                { id: 'study', label: 'Study Assistant', icon: '📚', prompt: 'Explain Quantum Physics like I am 11.' },
                { id: 'code', label: 'Code Monster', icon: '💻', prompt: 'Review this logic: if(x) { doY() }' },
                { id: 'idea', label: 'Idea Factory', icon: '💡', prompt: 'Give me a high-impact AI project idea.' }
              ].map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => {
                    setInput(mode.prompt);
                  }}
                  className="p-4 sm:p-6 border-2 border-scream-muted hover:border-scream-accent bg-scream-muted/20 text-left transition-all group hover:bg-scream-accent/10 active:scale-[0.98]"
                >
                  <div className="text-xl sm:text-2xl mb-2">{mode.icon}</div>
                  <div className="font-black uppercase tracking-tighter text-base sm:text-lg group-hover:text-scream-accent">
                    {mode.label}
                  </div>
                  <div className="text-[10px] sm:text-xs font-mono opacity-40 mt-1 line-clamp-1">
                    {mode.prompt}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4 sm:space-y-6">
        <AnimatePresence initial={false}>
          {messages.map((msg, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex gap-3 sm:gap-4 p-3 sm:p-4 rounded-sm border w-fit",
                msg.role === 'user' 
                  ? "flex-row-reverse border-scream-muted bg-white/5 ml-auto max-w-[90%] sm:max-w-[80%]" 
                  : "border-scream-accent bg-scream-accent/5 mr-auto max-w-[95%] sm:max-w-[90%]"
              )}
            >
              <div className="shrink-0 mt-1">
                {msg.role === 'user' ? (
                  msg.photoURL ? (
                    <img src={msg.photoURL} alt="User" className="w-6 h-6 sm:w-8 sm:h-8 rounded-full border border-scream-muted object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <UserIcon className="w-4 h-4 sm:w-5 sm:h-5 text-scream-muted" />
                  )
                ) : (
                  <div className="relative">
                    <Bot className="w-4 h-4 sm:w-5 sm:h-5 text-scream-accent" />
                    <div className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-scream-accent animate-ping rounded-full"></div>
                  </div>
                )}
              </div>
              <div className={cn(
                "space-y-2 overflow-hidden",
                msg.role === 'user' ? "text-right" : "text-left"
              )}>
                <div className="flex items-center gap-2 mb-1">
                   <p className={cn(
                     "text-[8px] sm:text-[10px] uppercase font-bold tracking-widest opacity-50",
                     msg.role === 'user' ? "ml-auto" : "mr-auto"
                   )}>
                    {msg.role === 'user' ? 'You' : 'ScreamAI'}
                  </p>
                </div>
                {msg.image && (
                  <img 
                    src={msg.image} 
                    alt="Uploaded" 
                    className={cn(
                      "max-w-full h-auto max-h-64 border border-scream-accent rounded-sm",
                      msg.role === 'user' ? "ml-auto" : "mr-auto"
                    )}
                    referrerPolicy="no-referrer"
                  />
                )}
                <div className="markdown-body text-xs sm:text-sm leading-relaxed font-mono">
                  <Markdown>{msg.content}</Markdown>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isLoading && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-3 sm:gap-4 p-3 sm:p-4 mr-auto border border-scream-accent bg-scream-accent/5 rounded-sm"
          >
            <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-scream-accent animate-spin" />
            <p className="text-xs sm:text-sm font-mono animate-pulse">Processing impact...</p>
          </motion.div>
        )}

        {error && (
          <div className="p-3 sm:p-4 border border-red-500 bg-red-500/10 text-red-500 flex items-center gap-3 rounded-sm">
            <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5" />
            <p className="text-xs sm:text-sm font-bold uppercase tracking-tight">{error}</p>
          </div>
        )}
        </div>
        <div ref={scrollRef} />
        </div>
      </main>

      {/* Input Area */}
      <footer className="p-4 border-t border-scream-accent bg-scream-bg sticky bottom-0 safe-pb">
        <div className="max-w-4xl mx-auto space-y-2">
          {selectedImage && (
            <div className="relative inline-block">
              <img 
                src={selectedImage} 
                alt="Preview" 
                className="w-20 h-20 object-cover border border-scream-accent"
              />
              <button 
                onClick={() => setSelectedImage(null)}
                className="absolute -top-2 -right-2 bg-scream-accent text-white p-1 rounded-full"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="relative flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageSelect}
              accept="image/*"
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-3 border border-scream-accent text-scream-accent hover:bg-scream-accent hover:text-white transition-all"
            >
              <ImageIcon className="w-5 h-5" />
            </button>
            <div className="relative flex-1">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={user ? "Bir şeyler yaz..." : "Geçmişi kaydetmek için giriş yap."}
                className="w-full bg-transparent border border-scream-accent p-3 sm:p-4 pr-14 sm:pr-16 focus:outline-none focus:ring-1 focus:ring-scream-accent font-mono text-xs sm:text-sm placeholder:text-scream-muted"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || (!input.trim() && !selectedImage)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-scream-accent text-scream-bg hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100"
              >
                <Send className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>
          </div>
        </div>
        <div className="max-w-4xl mx-auto flex justify-between items-center mt-2 px-1">
          <p className="text-[8px] sm:text-[10px] opacity-30 uppercase tracking-[0.2em] font-bold">
            Türk Yapımı
          </p>
          <p className="text-[8px] sm:text-[10px] opacity-30 uppercase tracking-[0.2em] font-bold">
            ScreamAI // Impact {'>'} Noise
          </p>
        </div>
      </footer>
    </div>
  </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ChatApp />
    </ErrorBoundary>
  );
}
