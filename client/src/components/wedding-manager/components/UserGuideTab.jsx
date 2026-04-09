import React, { useState } from 'react';
import Icon from './Icon';

const UserGuideTab = () => {
    const [activeTab, setActiveTab] = useState('staff');
    const [activeSection, setActiveSection] = useState('getting-started');

    const Tip = ({ children }) => (
        <div className="p-4 bg-gold-50 border border-gold-200 rounded-2xl flex gap-3 items-start mt-4">
            <Icon name="Lightbulb" size={16} className="text-gold-600 shrink-0 mt-0.5" />
            <p className="text-xs text-gold-900 leading-relaxed font-medium">{children}</p>
        </div>
    );

    const Warning = ({ children }) => (
        <div className="p-4 bg-red-50 border border-red-200 rounded-2xl flex gap-3 items-start mt-4">
            <Icon name="AlertTriangle" size={16} className="text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-800 leading-relaxed font-medium">{children}</p>
        </div>
    );

    const Step = ({ num, children }) => (
        <li className="flex gap-3 text-xs font-bold text-app-text">
            <div className="w-6 h-6 bg-navy-900 text-white rounded-full flex items-center justify-center shrink-0 text-[10px]">{num}</div>
            <span className="leading-relaxed">{children}</span>
        </li>
    );

    const KeyboardKey = ({ children }) => (
        <span className="px-1.5 py-0.5 bg-app-surface-2 border border-app-border rounded text-[10px] font-mono font-bold text-app-text shadow-sm">{children}</span>
    );

    const content = {
        staff: [
            {
                id: 'getting-started',
                title: 'Getting Started',
                icon: 'Compass',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Welcome to Riverside</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Everything you need to know to start using the system on day one.</p>
                        </header>

                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">The Four Main Tabs</h4>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <div className="flex items-center gap-2 mb-1"><Icon name="Users" size={14} className="text-app-text-muted" /><span className="text-[10px] font-black uppercase text-app-text">Parties</span></div>
                                    <p className="text-[10px] text-app-text-muted">Your home base. See all wedding parties, action items, and member statuses.</p>
                                </div>
                                <div className="p-3 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <div className="flex items-center gap-2 mb-1"><Icon name="Calendar" size={14} className="text-app-text-muted" /><span className="text-[10px] font-black uppercase text-app-text">Appointments</span></div>
                                    <p className="text-[10px] text-app-text-muted">Weekly schedule and monthly calendar. Book, edit, and track attendance.</p>
                                </div>
                                <div className="p-3 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <div className="flex items-center gap-2 mb-1"><Icon name="BarChart2" size={14} className="text-app-text-muted" /><span className="text-[10px] font-black uppercase text-app-text">Reports</span></div>
                                    <p className="text-[10px] text-app-text-muted">Shop analytics — party trends, pipeline status, salesperson leaderboard.</p>
                                </div>
                                <div className="p-3 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <div className="flex items-center gap-2 mb-1"><Icon name="Settings" size={14} className="text-app-text-muted" /><span className="text-[10px] font-black uppercase text-app-text">Settings</span></div>
                                    <p className="text-[10px] text-app-text-muted">This page — user guide, team management, database health, and logs.</p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Filtering Your View</h4>
                            <p className="text-xs text-app-text leading-relaxed mb-3">The filter bar at the top of the Parties tab lets you narrow down what you see:</p>
                            <ul className="space-y-2 text-xs text-app-text">
                                <li className="flex gap-2"><span className="font-black text-app-text">Search</span> — Type any name (groom, groomsman, bride) or phone number to find a party instantly</li>
                                <li className="flex gap-2"><span className="font-black text-app-text">Salesperson</span> — Filter to see only your assigned parties</li>
                                <li className="flex gap-2"><span className="font-black text-app-text">Time Range</span> — "Next 90 Days" shows urgent weddings first; "All Time" shows everything</li>
                                <li className="flex gap-2"><span className="font-black text-app-text">Month</span> — Jump directly to a specific wedding month</li>
                            </ul>
                        </div>

                        <div className="bg-navy-900 p-6 rounded-3xl text-white">
                            <h4 className="flex items-center gap-2 text-gold-500 font-black uppercase text-xs mb-3">
                                <Icon name="Smartphone" size={14} /> Works on Tablets & Phones
                            </h4>
                            <p className="text-xs opacity-90 leading-relaxed">
                                Riverside is fully responsive. On iPads, iPhones, or Android devices, the layout automatically adapts — member tables become swipeable cards with large tap-friendly buttons. You can run the entire shop from a tablet behind the counter.
                            </p>
                        </div>
                    </div>
                )
            },
            {
                id: 'dashboard',
                title: 'Action Dashboard',
                icon: 'Activity',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Action Dashboard</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Your daily to-do list, automatically organized by urgency.</p>
                        </header>

                        <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-3">The 6 Action Cards</h4>
                            <p className="text-xs text-app-text leading-relaxed mb-4">Each card shows members who need your attention. Members with weddings under 90 days away are flagged <b>urgent</b> and sorted to the top.</p>
                            <div className="space-y-2">
                                {[
                                    { icon: 'Calendar', color: 'text-app-text-muted', label: 'Upcoming Appts', desc: 'Appointments in the next few days. Click to open their party.' },
                                    { icon: 'CalendarX', color: 'text-red-500', label: 'Missed Appts', desc: 'No-shows that need follow-up. Call them to reschedule.' },
                                    { icon: 'Ruler', color: 'text-indigo-500', label: 'Needs Measure', desc: 'Members with empty sizes. They need to come in or call in measurements.' },
                                    { icon: 'ShoppingCart', color: 'text-amber-600', label: 'Needs Order', desc: 'Measured members whose order hasn\'t been placed yet. Check daily.' },
                                    { icon: 'Scissors', color: 'text-blue-500', label: 'Needs Fitting', desc: 'Orders received but member hasn\'t been fitted. Schedule them in.' },
                                    { icon: 'ShoppingBag', color: 'text-green-600', label: 'Needs Pickup', desc: 'Fitted and ready to go. Overdue pickups show a red badge.' },
                                ].map(card => (
                                    <div key={card.label} className="flex items-center gap-3 p-2.5 bg-app-surface-2 rounded-xl border border-app-border/80">
                                        <Icon name={card.icon} size={14} className={card.color} />
                                        <div><span className="text-[10px] font-black uppercase text-app-text">{card.label}</span><span className="text-[10px] text-app-text-muted ml-2">{card.desc}</span></div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="bg-navy-900 p-6 rounded-3xl text-white">
                            <h4 className="flex items-center gap-2 text-gold-500 font-black uppercase text-xs mb-3">
                                <Icon name="CheckCircle" size={14} /> The "Quick Done" Shortcut
                            </h4>
                            <p className="text-xs opacity-90 leading-relaxed">
                                See the <b>"✓ DONE"</b> button on each member row? Click it to instantly mark that task as complete without opening the full party. You'll be prompted to select your name for accountability, then the member disappears from the card.
                            </p>
                        </div>

                        <Tip>Start every shift by scrolling through the Action Dashboard. It tells you exactly what needs doing today — no guessing.</Tip>
                    </div>
                )
            },
            {
                id: 'parties',
                title: 'Party Management',
                icon: 'Users',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Managing Wedding Parties</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Creating, editing, and tracking a party from first call to wedding day.</p>
                        </header>

                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Creating a New Party</h4>
                            <ol className="space-y-3">
                                <Step num="1">Click the gold <b>"+ New Party"</b> button in the header.</Step>
                                <Step num="2">Enter the Groom/Bride's last name, wedding date, and assign a salesperson.</Step>
                                <Step num="3">Add members — type each groomsman/bridesmaid name and phone number.</Step>
                                <Step num="4">Hit <b>"Save Party"</b>. All members instantly appear on the Action Dashboard under "Needs Measure".</Step>
                            </ol>
                        </div>

                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Inside a Party — What You Can Do</h4>
                            <p className="text-xs text-app-text leading-relaxed mb-3">Click <b>"Manage"</b> on any party card to open it. Inside you'll find:</p>
                            <ul className="space-y-2 text-xs text-app-text">
                                <li>• <b>Member List</b> — View and edit all member sizes, phone, and OOT (out-of-town) status</li>
                                <li>• <b>Order Review</b> — Toggle pipeline stages (Measured → Ordered → Received → Fitted → Picked Up)</li>
                                <li>• <b>Salesperson</b> — Reassign the party to a different salesperson</li>
                                <li>• <b>+ Add Member</b> — Add late additions to the party</li>
                                <li>• <b>Style & Pricing</b> — Record the selected suit style, accessories, and pricing tier</li>
                                <li>• <b>Party Notes</b> — Add timestamped notes visible to all staff</li>
                                <li>• <b>Print View</b> — Generate a clean printout of the entire party for the fitting room</li>
                            </ul>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="p-5 bg-blue-50 border border-blue-100 rounded-3xl">
                                <h4 className="text-xs font-black text-blue-900 uppercase mb-2">OOT Members</h4>
                                <p className="text-xs text-blue-800 leading-relaxed font-medium">
                                    Mark out-of-town members with the <b>OOT</b> toggle. This helps track who will call in measurements vs. coming in person.
                                </p>
                            </div>
                            <div className="p-5 bg-emerald-50 border border-emerald-100 rounded-3xl">
                                <h4 className="text-xs font-black text-emerald-900 uppercase mb-2">Free Suit Eligibility</h4>
                                <p className="text-xs text-emerald-800 leading-relaxed font-medium">
                                    Parties with 5+ members qualify for a free suit. The system tracks this automatically and shows it in the Reports tab.
                                </p>
                            </div>
                        </div>

                    </div>
                )
            },
            {
                id: 'measurements',
                title: 'Measurements',
                icon: 'Ruler',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Recording Measurements</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">How to enter, edit, and verify member sizes.</p>
                        </header>
                        <div className="p-6 bg-app-surface-2 border border-app-border rounded-3xl">
                            <h4 className="text-xs font-black text-app-text uppercase mb-2">The Golden Rule: Press Enter</h4>
                            <p className="text-xs text-app-text leading-relaxed mb-4 italic">"Typing a size is not enough. You must commit it to the database."</p>
                            <ol className="space-y-3">
                                <Step num="1">Open a party and click into any size field (Suit, Waist, Vest, Shirt, or Shoe).</Step>
                                <Step num="2">Type the measurement (e.g. <b>42R</b>, <b>34</b>, <b>16.5</b>).</Step>
                                <Step num="3">Press <KeyboardKey>Enter</KeyboardKey> or <KeyboardKey>Tab</KeyboardKey> to move to the next field.</Step>
                                <Step num="4">Select your name in the "Identity Required" popup. This logs who entered the measurement.</Step>
                            </ol>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2">Member Notes</h4>
                                <p className="text-xs text-app-text-muted leading-relaxed">Click the <b>pencil icon</b> on any member row to add notes like "shorter left arm" or "needs extra length." Notes persist and are visible to all staff.</p>
                            </div>
                            <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2">Call-In Measurements</h4>
                                <p className="text-xs text-app-text-muted leading-relaxed">When an OOT member calls in sizes, enter them just like normal. The system logs it as "Called In" with a timestamp so you have proof of when the info was received.</p>
                            </div>
                        </div>
                        <Warning>If you type a measurement but navigate away without pressing Enter, it will NOT be saved. Always confirm the "Identity Required" popup appeared.</Warning>
                    </div>
                )
            },
            {
                id: 'pipeline',
                title: 'The Pipeline',
                icon: 'GitBranch',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">The 5-Stage Pipeline</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Every member flows through these stages from start to finish.</p>
                        </header>
                        <div className="bg-app-surface border border-app-border rounded-3xl overflow-hidden shadow-sm">
                            <div className="p-4 bg-app-surface-2 border-b border-app-border grid grid-cols-5 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                <div>Measured</div><div>Ordered</div><div>Received</div><div>Fitted</div><div>Picked Up</div>
                            </div>
                            <div className="p-6 text-xs text-app-text leading-relaxed">
                                <p className="mb-3">Switch to the <b>Order Review</b> tab inside any party to toggle these stages. Click a circle to mark that step complete — this controls which Action Dashboard card the member appears on.</p>
                                <div className="grid grid-cols-1 gap-2 mt-4">
                                    <div className="flex items-center gap-2 py-1"><span className="w-3 h-3 rounded-full bg-indigo-400"></span><span className="font-bold text-app-text">Measured</span> — All 5 size fields are filled in</div>
                                    <div className="flex items-center gap-2 py-1"><span className="w-3 h-3 rounded-full bg-amber-400"></span><span className="font-bold text-app-text">Ordered</span> — Order placed with the vendor</div>
                                    <div className="flex items-center gap-2 py-1"><span className="w-3 h-3 rounded-full bg-purple-400"></span><span className="font-bold text-app-text">Received</span> — Package arrived at the shop</div>
                                    <div className="flex items-center gap-2 py-1"><span className="w-3 h-3 rounded-full bg-blue-400"></span><span className="font-bold text-app-text">Fitted</span> — Customer tried it on and it fits</div>
                                    <div className="flex items-center gap-2 py-1"><span className="w-3 h-3 rounded-full bg-emerald-400"></span><span className="font-bold text-app-text">Picked Up</span> — Customer took the suit home</div>
                                </div>
                            </div>
                        </div>
                        <Tip>Use the "View Orders" button on the Needs Order action card to see a consolidated order checklist — perfect for calling in batch orders to the vendor.</Tip>
                    </div>
                )
            },
            {
                id: 'appointments',
                title: 'Appointments',
                icon: 'Calendar',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Calendar & Appointments</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Book, track, and manage all measurement and fitting appointments.</p>
                        </header>
                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Two Calendar Views</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="p-4 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <h5 className="text-[10px] font-black uppercase text-app-text mb-1">Weekly Schedule</h5>
                                    <p className="text-[10px] text-app-text-muted">Shows today's and this week's appointments with time slots and staff assignments. Use this for daily planning.</p>
                                </div>
                                <div className="p-4 bg-app-surface-2 rounded-2xl border border-app-border/80">
                                    <h5 className="text-[10px] font-black uppercase text-app-text mb-1">Monthly Calendar</h5>
                                    <p className="text-[10px] text-app-text-muted">Bird's-eye view of the whole month. Color-coded dots: blue = measurement, amber = fitting, green = pickup, pink = wedding day.</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Booking an Appointment</h4>
                            <ol className="space-y-3">
                                <Step num="1">Open a party and click the <b>calendar icon</b> next to any member's name.</Step>
                                <Step num="2">Select the appointment type (Measurement, Fitting, or Pickup).</Step>
                                <Step num="3">Pick a date, time, and assign a staff member.</Step>
                                <Step num="4">Save — the appointment appears on both the calendar and the Action Dashboard.</Step>
                            </ol>
                        </div>
                        <div className="p-5 bg-emerald-50 border border-emerald-100 rounded-3xl">
                            <h4 className="text-xs font-black text-emerald-900 uppercase mb-2">When a Customer Walks In</h4>
                            <div className="text-xs text-emerald-800 font-bold leading-relaxed">
                                Open their appointment → Click <b>"Mark Attended"</b> → This records the visit and can automatically advance their pipeline status (e.g. mark them as Measured). One click does 3 database updates at once.
                            </div>
                        </div>
                        <Warning>If a salesperson slot turns <b>RED</b> when booking, they already have an appointment at that time. Check for overlap before confirming.</Warning>
                    </div>
                )
            },
            {
                id: 'search',
                title: 'Search & Print',
                icon: 'Search',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Finding Records & Printing</h2>
                        </header>
                        <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-2">Master Search Bar</h4>
                            <p className="text-xs text-app-text-muted leading-relaxed">Type a groom's name, a groomsman's name, phone number, or even a wedding date. The system searches every field simultaneously and highlights matches.</p>
                        </div>
                        <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-2">Printing a Party Sheet</h4>
                            <p className="text-xs text-app-text-muted leading-relaxed">Open any party → click the <b>printer icon</b> in the header. This generates a clean, ink-friendly printout showing all member names, sizes, and pipeline status — ideal for pinning in the fitting room or including with shipped orders.</p>
                        </div>
                        <div className="p-5 bg-navy-900 rounded-3xl text-white">
                            <h4 className="text-xs font-black uppercase text-gold-500 mb-2">Recovering Deleted Parties</h4>
                            <p className="text-xs opacity-90 leading-relaxed mb-3">Parties are never truly erased — they are soft-deleted and hidden from the main view.</p>
                            <ol className="space-y-2">
                                <Step num="1"><span className="text-white">In the filter bar, click the <b>🗑 Deleted</b> button — it turns red.</span></Step>
                                <Step num="2"><span className="text-white">All deleted parties appear with a "DELETED" watermark.</span></Step>
                                <Step num="3"><span className="text-white">Click <b>"Restore Party"</b> on the card — confirm and select your name.</span></Step>
                                <Step num="4"><span className="text-white">The party reappears in the active list immediately, fully intact.</span></Step>
                            </ol>
                        </div>
                    </div>
                )
            }
        ],
        admin: [
            {
                id: 'team',
                title: 'Team Management',
                icon: 'Users',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Admin: Managing Your Team</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Add, rename, and remove salespeople.</p>
                        </header>
                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">Adding & Removing Staff</h4>
                            <ol className="space-y-3">
                                <Step num="1">Go to <b>Settings → Team</b> tab.</Step>
                                <Step num="2">Type the new salesperson's name and click <b>"Add"</b>.</Step>
                                <Step num="3">They'll immediately appear in all dropdowns (salesperson filter, appointment booking, attribution prompts).</Step>
                            </ol>
                        </div>
                        <Warning>If a staff member leaves, do <b>not</b> delete them immediately if they have active parties or appointments. Their name stays in audit logs for historical accountability. Consider renaming them to "Inactive - [Name]" instead.</Warning>
                        <div className="p-5 bg-navy-900 rounded-3xl text-white">
                            <h4 className="text-xs font-black uppercase text-gold-500 mb-2">The Admin Passcode</h4>
                            <p className="text-xs opacity-90 leading-relaxed">Set a passcode in <b>Settings → General</b> to restrict access to the Database tab. This prevents staff from accidentally deleting data or running maintenance operations.</p>
                        </div>
                    </div>
                )
            },
            {
                id: 'reports',
                title: 'Reading Reports',
                icon: 'BarChart2',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Admin: Understanding Reports</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">What each metric means and how to use the analytics.</p>
                        </header>
                        <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-3">The 4 Summary Cards</h4>
                            <div className="space-y-2">
                                <div className="flex items-start gap-3 p-2 bg-app-surface-2 rounded-xl"><span className="text-[10px] font-black text-app-text w-28 shrink-0">Parties (90 Days)</span><span className="text-[10px] text-app-text-muted">Total active parties with weddings in the next 3 months, plus total member count.</span></div>
                                <div className="flex items-start gap-3 p-2 bg-app-surface-2 rounded-xl"><span className="text-[10px] font-black text-app-text w-28 shrink-0">Completion Rate</span><span className="text-[10px] text-app-text-muted">Percentage of members who've completed all 5 pipeline stages. Aim for 95%+ before each wedding month.</span></div>
                                <div className="flex items-start gap-3 p-2 bg-app-surface-2 rounded-xl"><span className="text-[10px] font-black text-app-text w-28 shrink-0">Appointments</span><span className="text-[10px] text-app-text-muted">Upcoming appointment count and overall attendance rate.</span></div>
                                <div className="flex items-start gap-3 p-2 bg-app-surface-2 rounded-xl"><span className="text-[10px] font-black text-app-text w-28 shrink-0">Free Suit Eligible</span><span className="text-[10px] text-app-text-muted">Parties with 5+ members that qualify for a free groom's suit. Track revenue impact here.</span></div>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2">Monthly Trends Chart</h4>
                                <p className="text-[10px] text-app-text-muted leading-relaxed">Shows party and member counts by month. Use this to anticipate busy seasons (typically April–June and September–October).</p>
                            </div>
                            <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2">Pipeline Status</h4>
                                <p className="text-[10px] text-app-text-muted leading-relaxed">Color-coded bars showing how many members are at each pipeline stage. If "Needs Order" is stacking up, prioritize placing vendor orders.</p>
                            </div>
                        </div>
                        <Tip>Review the Reports tab every Monday morning. It's the fastest way to spot bottlenecks before they become problems.</Tip>
                    </div>
                )
            },
            {
                id: 'database',
                title: 'Data & Backups',
                icon: 'Database',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Admin: Data Protection</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Backups, database health, and data import.</p>
                        </header>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2 flex items-center gap-2"><Icon name="Activity" size={14} className="text-gold-500" /> System Health Tab</h4>
                                <p className="text-[10px] text-app-text-muted leading-relaxed">Go to <b>Settings → System Health</b> to run live diagnostics. It checks database integrity, fragmentation level, and shows record counts. Green = healthy.</p>
                            </div>
                            <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                                <h4 className="text-xs font-black text-app-text uppercase mb-2 flex items-center gap-2"><Icon name="Zap" size={14} className="text-blue-500" /> Auto-Optimization</h4>
                                <p className="text-[10px] text-app-text-muted leading-relaxed">Every Monday at 1 AM, the system runs a VACUUM to prevent slowdowns as data grows. You can also trigger a manual Optimize from the Database tab.</p>
                            </div>
                        </div>
                        <div className="p-6 bg-navy-900 rounded-3xl text-white">
                            <h4 className="text-xs font-black text-gold-500 uppercase mb-2 flex items-center gap-2"><Icon name="Save" size={14} /> Weekly Safety Snapshots</h4>
                            <p className="text-[11px] opacity-80 leading-relaxed">The system is self-healing, but manual backups are your ultimate insurance. Download a snapshot to a USB drive every Saturday from the <b>Database</b> tab. If anything ever goes wrong, you can restore from that snapshot.</p>
                        </div>
                        <div className="p-5 bg-blue-50 border border-blue-100 rounded-3xl">
                            <h4 className="text-xs font-black text-blue-900 uppercase mb-2">Importing Data</h4>
                            <p className="text-xs text-blue-800 leading-relaxed font-medium">Use <b>Settings → Database → Import</b> to bulk-load parties from a spreadsheet. The importer maps columns automatically and shows a preview before committing. Great for migrating from a paper system.</p>
                        </div>
                    </div>
                )
            },
            {
                id: 'logs',
                title: 'Audit Logs',
                icon: 'FileText',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Admin: Audit Trail</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Every change is tracked. Here's how to read the logs.</p>
                        </header>
                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4">What Gets Logged</h4>
                            <ul className="space-y-2 text-xs text-app-text">
                                <li>• Every measurement change (with old → new values)</li>
                                <li>• Pipeline status updates (who marked what and when)</li>
                                <li>• Appointment bookings, cancellations, and attendance</li>
                                <li>• Party creation, deletion, and member additions</li>
                                <li>• Style/pricing changes and note additions</li>
                            </ul>
                        </div>
                        <div className="p-4 bg-app-surface-2 rounded-2xl border border-app-border">
                            <h5 className="text-[10px] font-black text-app-text uppercase mb-2">Example Log Entry</h5>
                            <div className="bg-app-surface p-3 rounded-xl border border-app-border font-mono text-[10px] text-app-text-muted leading-relaxed">
                                <div>Action: <b>Update Size</b></div>
                                <div>Details: ROBYN changed Waist <span className="text-red-500">32</span> → <span className="text-emerald-600">34</span></div>
                                <div>Member: JOSH BADALICH (BRITTIN party)</div>
                                <div>Timestamp: Feb 19, 2026 at 11:05 AM</div>
                            </div>
                        </div>
                        <Tip>Check the Logs tab if a customer disputes a measurement. You can see exactly who entered what and when — complete accountability.</Tip>
                    </div>
                )
            },
            {
                id: 'resilience',
                title: 'Server & Uptime',
                icon: 'Shield',
                html: (
                    <div className="space-y-6">
                        <header className="border-b border-app-border/80 pb-4">
                            <h2 className="text-2xl font-black text-app-text uppercase">Admin: Server Uptime</h2>
                            <p className="text-xs text-app-text-muted font-medium mt-1">Keeping the system running 24/7.</p>
                        </header>
                        <div className="p-6 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-4 flex items-center gap-2"><Icon name="Power" size={14} className="text-emerald-500" /> Auto-Start on Reboot</h4>
                            <p className="text-[11px] text-app-text-muted leading-relaxed mb-4">The server can auto-start when the computer reboots, so no one needs to manually launch it after a power outage or Windows update.</p>
                            <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                                <div className="text-[10px] text-emerald-800 font-bold uppercase tracking-tight">System Health → Click "Enable Auto-Start"</div>
                            </div>
                        </div>
                        <div className="p-5 bg-navy-900 rounded-3xl text-white">
                            <h4 className="text-xs font-black text-gold-500 uppercase mb-2 flex items-center gap-2"><Icon name="ShieldCheck" size={14} /> Self-Healing Process Manager</h4>
                            <p className="text-xs opacity-80 leading-relaxed font-medium">The system uses <b>PM2</b> (a professional process manager). If the server crashes due to a power flicker or memory issue, it automatically restarts in under 2 seconds — no intervention needed.</p>
                        </div>
                        <div className="p-5 bg-app-surface border border-app-border rounded-3xl shadow-sm">
                            <h4 className="text-xs font-black text-app-text uppercase mb-2">Network Access</h4>
                            <p className="text-xs text-app-text-muted leading-relaxed">Any device on the shop's Wi-Fi can access the system by visiting the server's IP address in a browser. No app install needed — just open Chrome or Safari on an iPad and bookmark the page.</p>
                        </div>
                    </div>
                )
            }
        ]
    };

    return (
        <div className="flex h-full animate-in fade-in duration-500 bg-app-surface overflow-hidden">
            {/* Nav Sidebar */}
            <div className="w-56 border-r border-app-border flex flex-col bg-app-surface-2 shrink-0">
                <div className="p-6 border-b border-app-border">
                    <p className="text-app-text font-black text-2xl tracking-tighter leading-none italic">Riverside</p>
                    <p className="text-[9px] font-black text-gold-600 uppercase tracking-widest mt-1">Operational Manual</p>
                </div>

                <div className="flex-1 flex flex-col p-4 space-y-8 overflow-y-auto custom-scrollbar">
                    {/* Role Switcher */}
                    <div className="flex p-1 bg-app-border/50 rounded-2xl">
                        <button type="button"
                            onClick={() => { setActiveTab('staff'); setActiveSection('getting-started'); }}
                            className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${activeTab === 'staff' ? 'bg-app-surface text-app-text shadow-sm' : 'text-app-text-muted hover:text-app-text'}`}
                        >
                            Staff
                        </button>
                        <button type="button"
                            onClick={() => { setActiveTab('admin'); setActiveSection('team'); }}
                            className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${activeTab === 'admin' ? 'bg-navy-900 text-white shadow-sm' : 'text-app-text-muted hover:text-app-text'}`}
                        >
                            Admin
                        </button>
                    </div>

                    <div className="space-y-1">
                        <h4 className="px-4 text-[9px] font-black text-app-text-muted uppercase tracking-widest mb-3">
                            {activeTab === 'staff' ? 'Staff Training' : 'Admin Operations'}
                        </h4>
                        {content[activeTab].map(section => (
                            <button type="button"
                                key={section.id}
                                onClick={() => setActiveSection(section.id)}
                                className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all text-left
                                    ${activeSection === section.id
                                        ? 'bg-app-surface text-app-text shadow-md ring-1 ring-black/5 font-black'
                                        : 'text-app-text-muted hover:bg-app-surface-2 hover:text-app-text font-bold'
                                    }`}
                            >
                                <Icon name={section.icon} size={16} className={activeSection === section.id ? 'text-gold-500' : 'text-app-text-muted'} />
                                <span className="text-[11px] uppercase tracking-tight">{section.title}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="p-4 border-t border-app-border bg-app-surface-2 text-center">
                    <span className="text-[9px] font-black text-app-text-muted uppercase tracking-widest">Manual v5.0 — Feb 2026</span>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-12 bg-app-surface-2/5">
                <div className="max-w-[750px] mx-auto animate-in slide-in-from-bottom-4 duration-300">
                    {content[activeTab].find(s => s.id === activeSection)?.html}
                </div>
            </div>
        </div>
    );
};

export default UserGuideTab;
