// Jarvis Enhanced Features Concept
// These features work without requiring Claude access

// 1. ACTION ITEM EXTRACTION
// Processes transcripts to find actionable items
async function extractActions(transcript) {
    const actionPatterns = [
        { pattern: /schedule (.*?) (meeting|call|appointment)/i, type: 'calendar' },
        { pattern: /remind me to (.*)/i, type: 'reminder' },
        { pattern: /need to (.*)/i, type: 'task' },
        { pattern: /don't forget (.*)/i, type: 'reminder' },
        { pattern: /buy (.*)/i, type: 'shopping' },
        { pattern: /email (.*?) about (.*)/i, type: 'email' },
        { pattern: /call (.*)/i, type: 'call' },
        { pattern: /meeting (?:with )?(.*?) (?:at|on) (.*)/i, type: 'calendar' }
    ];

    const actions = [];
    for (const {pattern, type} of actionPatterns) {
        const match = transcript.match(pattern);
        if (match) {
            actions.push({
                type,
                text: match[0],
                details: match.slice(1),
                timestamp: new Date()
            });
        }
    }
    return actions;
}

// 2. SMART NOTIFICATIONS
// Shows contextual notifications based on conversation
function showActionNotification(action) {
    return {
        title: "Jarvis detected an action item",
        message: action.text,
        buttons: [
            { text: "Add to Calendar", action: "calendar", data: action },
            { text: "Create Reminder", action: "reminder", data: action },
            { text: "Dismiss", action: "dismiss" }
        ]
    };
}

// 3. CONVERSATION INSIGHTS
// Analyzes conversation patterns without AI
function analyzeConversation(messages) {
    return {
        totalMessages: messages.length,
        participants: [...new Set(messages.map(m => m.speaker))],
        
        // Detect questions
        questions: messages.filter(m => 
            m.text.includes('?') || 
            m.text.match(/^(what|when|where|who|why|how)/i)
        ),
        
        // Detect decisions
        decisions: messages.filter(m => 
            m.text.match(/(decided|agreed|let's|we'll|going to|plan to)/i)
        ),
        
        // Extract mentioned people
        people: extractPeople(messages),
        
        // Extract time references
        timeReferences: extractTimeReferences(messages),
        
        // Sentiment (basic)
        sentiment: calculateBasicSentiment(messages)
    };
}

// 4. QUICK ACTIONS WITHOUT CLAUDE
// Direct integrations that work locally
const localActions = {
    // Creates a draft email with extracted info
    createEmailDraft: (recipient, subject, body) => {
        const mailtoLink = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.location.href = mailtoLink;
    },
    
    // Creates calendar event URL (works with Google Calendar)
    createCalendarEvent: (title, date, details) => {
        const startDate = new Date(date).toISOString().replace(/-|:|\.\d\d\d/g, '');
        const endDate = new Date(new Date(date).getTime() + 3600000).toISOString().replace(/-|:|\.\d\d\d/g, '');
        const calendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${startDate}/${endDate}&details=${encodeURIComponent(details)}`;
        window.open(calendarUrl, '_blank');
    },
    
    // Creates a todo list in markdown
    createTodoList: (items) => {
        const markdown = items.map(item => `- [ ] ${item}`).join('\n');
        navigator.clipboard.writeText(markdown);
        return "Todo list copied to clipboard!";
    },
    
    // Generates meeting notes template
    generateMeetingNotes: (transcript) => {
        const template = `
# Meeting Notes - ${new Date().toLocaleDateString()}

## Participants
${extractParticipants(transcript).join(', ')}

## Key Points Discussed
${extractKeyPoints(transcript).map(p => `- ${p}`).join('\n')}

## Action Items
${extractActions(transcript).map(a => `- [ ] ${a.text}`).join('\n')}

## Next Steps
[To be filled]

## Questions/Follow-ups
${extractQuestions(transcript).map(q => `- ${q}`).join('\n')}
        `;
        return template;
    }
};

// 5. SMART SUGGESTIONS
// Provides contextual suggestions based on time and conversation
function getSmartSuggestions(context) {
    const hour = new Date().getHours();
    const suggestions = [];
    
    // Time-based suggestions
    if (hour < 9) {
        suggestions.push({
            icon: "☕",
            text: "Review today's calendar",
            action: () => checkCalendar()
        });
    } else if (hour >= 17) {
        suggestions.push({
            icon: "📝",
            text: "Create tomorrow's task list",
            action: () => createTasks()
        });
    }
    
    // Context-based suggestions
    if (context.hasUnreadMessages) {
        suggestions.push({
            icon: "📬",
            text: "Check unread messages",
            action: () => checkMessages()
        });
    }
    
    if (context.hasPendingTasks) {
        suggestions.push({
            icon: "✅",
            text: "Review pending tasks",
            action: () => reviewTasks()
        });
    }
    
    return suggestions;
}

// 6. LOCAL STORAGE SYNC
// Keeps track of user preferences and history locally
class JarvisLocalStorage {
    constructor() {
        this.storage = window.localStorage;
    }
    
    saveAction(action) {
        const actions = this.getActions();
        actions.push({...action, id: Date.now()});
        this.storage.setItem('jarvis_actions', JSON.stringify(actions));
    }
    
    getActions() {
        return JSON.parse(this.storage.getItem('jarvis_actions') || '[]');
    }
    
    getPendingActions() {
        return this.getActions().filter(a => !a.completed);
    }
    
    markCompleted(actionId) {
        const actions = this.getActions();
        const action = actions.find(a => a.id === actionId);
        if (action) {
            action.completed = true;
            action.completedAt = new Date();
            this.storage.setItem('jarvis_actions', JSON.stringify(actions));
        }
    }
    
    getAnalytics() {
        const actions = this.getActions();
        return {
            total: actions.length,
            completed: actions.filter(a => a.completed).length,
            pending: actions.filter(a => !a.completed).length,
            byType: actions.reduce((acc, a) => {
                acc[a.type] = (acc[a.type] || 0) + 1;
                return acc;
            }, {})
        };
    }
}

// 7. WEBHOOK ENHANCED PROCESSING
// Enhanced webhook that actually processes and stores insights
app.post('/webhook/enhanced', async (req, res) => {
    const { segments, session_id } = req.body;
    
    // Extract actions from transcript
    const transcript = segments.map(s => s.text).join(' ');
    const actions = await extractActions(transcript);
    
    // Analyze conversation
    const insights = analyzeConversation(segments);
    
    // Store in database
    await supabase
        .from('jarvis_insights')
        .insert({
            session_id,
            actions,
            insights,
            transcript,
            created_at: new Date()
        });
    
    // If high-priority action detected, return notification
    const urgentAction = actions.find(a => 
        a.text.match(/urgent|asap|important|today/i)
    );
    
    if (urgentAction) {
        return res.json({
            notification: {
                prompt: `Urgent action detected: ${urgentAction.text}. Would you like me to help you with this?`,
                action: urgentAction
            }
        });
    }
    
    return res.json({ 
        actions_detected: actions.length,
        insights 
    });
});

// 8. DAILY BRIEFING
// Generates a daily summary without AI
async function generateDailyBriefing() {
    const today = new Date();
    const storage = new JarvisLocalStorage();
    
    return {
        date: today.toLocaleDateString(),
        greeting: getTimeBasedGreeting(),
        
        // Today's agenda
        calendar: {
            events: await getCalendarEvents(today),
            freeSlots: await findFreeTimeSlots(today)
        },
        
        // Pending items
        pending: {
            tasks: storage.getPendingActions().filter(a => a.type === 'task'),
            reminders: storage.getPendingActions().filter(a => a.type === 'reminder'),
            followUps: storage.getPendingActions().filter(a => a.type === 'email' || a.type === 'call')
        },
        
        // Yesterday's summary
        yesterday: {
            completed: storage.getActions().filter(a => 
                a.completedAt && 
                new Date(a.completedAt).toDateString() === new Date(Date.now() - 86400000).toDateString()
            ),
            transcript_count: await getYesterdayTranscriptCount()
        },
        
        // Smart suggestions
        suggestions: getSmartSuggestions({
            hasUnreadMessages: await checkUnreadMessages(),
            hasPendingTasks: storage.getPendingActions().length > 0
        })
    };
}

function getTimeBasedGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
}

module.exports = {
    extractActions,
    analyzeConversation,
    localActions,
    getSmartSuggestions,
    JarvisLocalStorage,
    generateDailyBriefing
};