"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { StatusBadge } from "@/components/status-badge";
import { ScheduleStatusBadge } from "@/components/schedule-status-badge";
import { StatsCard } from "@/components/stats-card";
import { JobDetailModal } from "@/components/job-detail-modal";
import { ScheduleDetailModal } from "@/components/schedule-detail-modal";
import {
  fetchJobs,
  fetchStats,
  fetchSchedules,
  cancelJob,
  retryJob,
  pauseSchedule as apiPauseSchedule,
  resumeSchedule as apiResumeSchedule,
  deleteSchedule as apiDeleteSchedule,
  type Job,
  type JobStatus,
  type Stats,
  type Schedule,
  type ScheduleStatus,
} from "@/lib/api";
import {
  Search,
  RefreshCw,
  MoreVertical,
  RotateCcw,
  Trash2,
  Eye,
  TrendingUp,
  Clock,
  XCircle,
  Activity,
  Loader2,
  AlertTriangle,
  Calendar,
  PlayCircle,
  PauseCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const ITEMS_PER_PAGE = 20;
const FETCH_LIMIT = 200;

export default function DashboardPage() {
  // Main view state
  const [mainView, setMainView] = useState<"jobs" | "schedules">("jobs");

  // Jobs states
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedJobTab, setSelectedJobTab] = useState<JobStatus | "ALL">("ALL");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [isJobModalOpen, setIsJobModalOpen] = useState(false);
  const [allJobs, setAllJobs] = useState<Job[]>([]);

  // Schedules states
  const [scheduleSearchQuery, setScheduleSearchQuery] = useState("");
  const [selectedScheduleTab, setSelectedScheduleTab] = useState<ScheduleStatus | "ALL">("ALL");
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [allSchedules, setAllSchedules] = useState<Schedule[]>([]);

  // Common states
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination states
  const [jobsPage, setJobsPage] = useState(1);
  const [schedulesPage, setSchedulesPage] = useState(1);

  // Client-side filtering for jobs
  const filteredJobs = allJobs.filter((job) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      job.name.toLowerCase().includes(query) ||
      job.id.toLowerCase().includes(query)
    );
  });

  // Client-side filtering for schedules
  const filteredSchedules = allSchedules.filter((schedule) => {
    if (!scheduleSearchQuery) return true;
    const query = scheduleSearchQuery.toLowerCase();
    return (
      schedule.name.toLowerCase().includes(query) ||
      schedule.handlerName.toLowerCase().includes(query) ||
      schedule.id.toLowerCase().includes(query)
    );
  });

  // Paginated data
  const paginatedJobs = filteredJobs.slice(
    (jobsPage - 1) * ITEMS_PER_PAGE,
    jobsPage * ITEMS_PER_PAGE
  );
  const paginatedSchedules = filteredSchedules.slice(
    (schedulesPage - 1) * ITEMS_PER_PAGE,
    schedulesPage * ITEMS_PER_PAGE
  );

  const totalJobPages = Math.ceil(filteredJobs.length / ITEMS_PER_PAGE);
  const totalSchedulePages = Math.ceil(filteredSchedules.length / ITEMS_PER_PAGE);

  // Reset page when search changes
  useEffect(() => {
    setJobsPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setSchedulesPage(1);
  }, [scheduleSearchQuery]);

  // Fetch data function
  const loadData = useCallback(async (showRefreshSpinner = false) => {
    try {
      if (showRefreshSpinner) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      // Fetch jobs, stats, and schedules in parallel
      const [jobsResponse, statsResponse, schedulesResponse] = await Promise.all([
        fetchJobs({
          status: selectedJobTab,
          limit: FETCH_LIMIT,
        }),
        fetchStats(),
        fetchSchedules({
          status: selectedScheduleTab,
          limit: FETCH_LIMIT,
        }).catch(() => ({ schedules: [], total: 0 })), // Gracefully handle if schedules aren't supported yet
      ]);

      setAllJobs(jobsResponse.jobs);
      setStats(statsResponse);
      setAllSchedules(schedulesResponse.schedules);
    } catch (err: any) {
      console.error("Failed to load data:", err);
      setError(err.message || "Failed to connect to server");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [selectedJobTab, selectedScheduleTab]);

  // Initial load and when dependencies change
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset page when tab changes
  useEffect(() => {
    setJobsPage(1);
  }, [selectedJobTab]);

  useEffect(() => {
    setSchedulesPage(1);
  }, [selectedScheduleTab]);

  // Job handlers
  const openJobDetail = (job: Job) => {
    setSelectedJob(job);
    setIsJobModalOpen(true);
  };

  const handleCancelJob = async (job: Job) => {
    try {
      const result = await cancelJob(job.id);
      if (result.success) {
        loadData(true);
      } else {
        alert(result.message || "Failed to cancel job");
      }
    } catch (err: any) {
      alert(err.message || "Failed to cancel job");
    }
  };

  const handleRetryJob = async (job: Job) => {
    try {
      const result = await retryJob(job.id);
      if (result.success) {
        loadData(true);
      } else {
        alert(result.message || "Failed to retry job");
      }
    } catch (err: any) {
      alert(err.message || "Failed to retry job");
    }
  };

  // Schedule handlers
  const openScheduleDetail = (schedule: Schedule) => {
    setSelectedSchedule(schedule);
    setIsScheduleModalOpen(true);
  };

  const handlePauseSchedule = async (schedule: Schedule) => {
    try {
      const result = await apiPauseSchedule(schedule.id);
      if (result.success) {
        loadData(true);
      } else {
        alert("Failed to pause schedule");
      }
    } catch (err: any) {
      alert(err.message || "Failed to pause schedule");
    }
  };

  const handleResumeSchedule = async (schedule: Schedule) => {
    try {
      const result = await apiResumeSchedule(schedule.id);
      if (result.success) {
        loadData(true);
      } else {
        alert("Failed to resume schedule");
      }
    } catch (err: any) {
      alert(err.message || "Failed to resume schedule");
    }
  };

  const handleDeleteSchedule = async (schedule: Schedule) => {
    try {
      const result = await apiDeleteSchedule(schedule.id);
      if (result.success) {
        loadData(true);
      } else {
        alert(result.message || "Failed to delete schedule");
      }
    } catch (err: any) {
      alert(err.message || "Failed to delete schedule");
    }
  };

  const formatDuration = (ms?: number | null) => {
    if (ms === null || ms === undefined) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Show loading state
  if (isLoading && !stats) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-secondary/20">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-muted-foreground">Connecting to Reseolio server...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error && !stats) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-secondary/20">
        <div className="flex flex-col items-center gap-4 text-center max-w-md">
          <AlertTriangle className="h-12 w-12 text-orange-500" />
          <h2 className="text-xl font-semibold">Connection Error</h2>
          <p className="text-muted-foreground">{error}</p>
          <p className="text-sm text-muted-foreground">
            Make sure the Reseolio server is running on localhost:50051
          </p>
          <Button onClick={() => loadData()} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Count active and paused schedules
  const activeSchedules = allSchedules.filter(s => s.status === "ACTIVE").length;
  const pausedSchedules = allSchedules.filter(s => s.status === "PAUSED").length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/20">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="/logo.png"
                alt="Reseolio"
                className="h-10 w-10 object-contain"
              />
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
                  Reseolio Dashboard
                </h1>
                <p className="text-sm text-muted-foreground">
                  Monitor and manage your background jobs
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => loadData(true)}
                disabled={isRefreshing}
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 mb-8 animate-in">
          <StatsCard
            title="Total Jobs"
            value={stats?.totalJobs?.toLocaleString() || "0"}
            icon={Activity}
            description="All time"
          />
          <StatsCard
            title="Success Rate"
            value={`${stats?.successRate || 0}%`}
            icon={TrendingUp}
          />
          <StatsCard
            title="Pending"
            value={stats?.pendingCount || 0}
            icon={Clock}
            description="Waiting to execute"
          />
          <StatsCard
            title="Running"
            value={stats?.runningCount || 0}
            icon={Activity}
            description="Currently executing"
          />
          <StatsCard
            title="Dead Jobs"
            value={stats?.deadCount || 0}
            icon={XCircle}
            description="Needs attention"
          />
          <StatsCard
            title="Schedules"
            value={allSchedules.length}
            icon={Calendar}
            description={`${activeSchedules} active, ${pausedSchedules} paused`}
          />
        </div>

        {/* Main View Toggle */}
        <Tabs value={mainView} onValueChange={(v) => setMainView(v as "jobs" | "schedules")} className="space-y-4">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="jobs" className="gap-2">
              <Activity className="h-4 w-4" />
              Jobs
            </TabsTrigger>
            <TabsTrigger value="schedules" className="gap-2">
              <Calendar className="h-4 w-4" />
              Schedules
            </TabsTrigger>
          </TabsList>

          {/* Jobs View */}
          <TabsContent value="jobs" className="space-y-0">
            <div className="bg-card rounded-lg border shadow-sm animate-in">
              <div className="p-6 space-y-4">
                {/* Search and Filters */}
                <div className="flex items-center gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search jobs by name..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  {searchQuery && (
                    <span className="text-sm text-muted-foreground">
                      Showing results for &quot;{searchQuery}&quot;
                    </span>
                  )}
                </div>

                {/* Job Status Tabs */}
                <Tabs value={selectedJobTab} onValueChange={(v) => setSelectedJobTab(v as typeof selectedJobTab)}>
                  <TabsList>
                    <TabsTrigger value="ALL">
                      All <span className="ml-2 text-xs opacity-60">({stats?.totalJobs || 0})</span>
                    </TabsTrigger>
                    <TabsTrigger value="PENDING">
                      Pending <span className="ml-2 text-xs opacity-60">({stats?.pendingCount || 0})</span>
                    </TabsTrigger>
                    <TabsTrigger value="RUNNING">
                      Running <span className="ml-2 text-xs opacity-60">({stats?.runningCount || 0})</span>
                    </TabsTrigger>
                    <TabsTrigger value="SUCCESS">
                      Success <span className="ml-2 text-xs opacity-60">({stats?.successCount || 0})</span>
                    </TabsTrigger>
                    <TabsTrigger value="CANCELLED">
                      Cancelled <span className="ml-2 text-xs opacity-60">({stats?.cancelledCount || 0})</span>
                    </TabsTrigger>
                    <TabsTrigger value="DEAD">
                      Dead <span className="ml-2 text-xs opacity-60">({stats?.deadCount || 0})</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value={selectedJobTab} className="mt-4">
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Status</TableHead>
                            <TableHead>Job Name</TableHead>
                            <TableHead>Job ID</TableHead>
                            <TableHead>Attempt</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Duration</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {isLoading ? (
                            <TableRow>
                              <TableCell colSpan={7} className="text-center py-8">
                                <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                              </TableCell>
                            </TableRow>
                          ) : paginatedJobs.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                                {searchQuery
                                  ? `No jobs found matching "${searchQuery}"`
                                  : "No jobs found"
                                }
                              </TableCell>
                            </TableRow>
                          ) : (
                            paginatedJobs.map((job: Job) => (
                              <TableRow
                                key={job.id}
                                className="hover:bg-muted/50 transition-colors cursor-pointer"
                                onClick={() => openJobDetail(job)}
                              >
                                <TableCell>
                                  <StatusBadge status={job.status} />
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                  {job.name}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                  {job.id.slice(0, 8)}...
                                </TableCell>
                                <TableCell>
                                  <span className="text-sm">
                                    {job.attempt}/{job.maxAttempts}
                                  </span>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground" suppressHydrationWarning>
                                  {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {job.completedAt && job.startedAt
                                    ? formatDuration(job.completedAt - job.startedAt)
                                    : "-"}
                                </TableCell>
                                <TableCell className="text-right">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        className="gap-2"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openJobDetail(job);
                                        }}
                                      >
                                        <Eye className="h-4 w-4" />
                                        View Details
                                      </DropdownMenuItem>
                                      {(job.status === "FAILED" || job.status === "DEAD") && (
                                        <DropdownMenuItem
                                          className="gap-2"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRetryJob(job);
                                          }}
                                        >
                                          <RotateCcw className="h-4 w-4" />
                                          Retry Job
                                        </DropdownMenuItem>
                                      )}
                                      {job.status === "PENDING" && (
                                        <DropdownMenuItem
                                          className="gap-2 text-destructive"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleCancelJob(job);
                                          }}
                                        >
                                          <Trash2 className="h-4 w-4" />
                                          Cancel Job
                                        </DropdownMenuItem>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Jobs Pagination */}
                    {totalJobPages > 1 && (
                      <div className="flex items-center justify-between mt-4">
                        <p className="text-sm text-muted-foreground">
                          Showing {Math.min((jobsPage - 1) * ITEMS_PER_PAGE + 1, filteredJobs.length)} to{" "}
                          {Math.min(jobsPage * ITEMS_PER_PAGE, filteredJobs.length)} of {filteredJobs.length} jobs
                        </p>
                        <Pagination>
                          <PaginationContent>
                            <PaginationItem>
                              <PaginationPrevious
                                onClick={() => setJobsPage((p) => Math.max(1, p - 1))}
                                className={jobsPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                              />
                            </PaginationItem>

                            {Array.from({ length: Math.min(5, totalJobPages) }, (_, i) => {
                              let pageNum: number;
                              if (totalJobPages <= 5) {
                                pageNum = i + 1;
                              } else if (jobsPage <= 3) {
                                pageNum = i + 1;
                              } else if (jobsPage >= totalJobPages - 2) {
                                pageNum = totalJobPages - 4 + i;
                              } else {
                                pageNum = jobsPage - 2 + i;
                              }

                              return (
                                <PaginationItem key={pageNum}>
                                  <PaginationLink
                                    onClick={() => setJobsPage(pageNum)}
                                    isActive={jobsPage === pageNum}
                                    className="cursor-pointer"
                                  >
                                    {pageNum}
                                  </PaginationLink>
                                </PaginationItem>
                              );
                            })}

                            <PaginationItem>
                              <PaginationNext
                                onClick={() => setJobsPage((p) => Math.min(totalJobPages, p + 1))}
                                className={jobsPage === totalJobPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                              />
                            </PaginationItem>
                          </PaginationContent>
                        </Pagination>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </TabsContent>

          {/* Schedules View */}
          <TabsContent value="schedules" className="space-y-0">
            <div className="bg-card rounded-lg border shadow-sm animate-in">
              <div className="p-6 space-y-4">
                {/* Search and Filters */}
                <div className="flex items-center gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search schedules by name or handler..."
                      value={scheduleSearchQuery}
                      onChange={(e) => setScheduleSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  {scheduleSearchQuery && (
                    <span className="text-sm text-muted-foreground">
                      Showing results for &quot;{scheduleSearchQuery}&quot;
                    </span>
                  )}
                </div>

                {/* Schedule Status Tabs */}
                <Tabs value={selectedScheduleTab} onValueChange={(v) => setSelectedScheduleTab(v as typeof selectedScheduleTab)}>
                  <TabsList>
                    <TabsTrigger value="ALL">
                      All <span className="ml-2 text-xs opacity-60">({allSchedules.length})</span>
                    </TabsTrigger>
                    <TabsTrigger value="ACTIVE">
                      Active <span className="ml-2 text-xs opacity-60">({activeSchedules})</span>
                    </TabsTrigger>
                    <TabsTrigger value="PAUSED">
                      Paused <span className="ml-2 text-xs opacity-60">({pausedSchedules})</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value={selectedScheduleTab} className="mt-4">
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Status</TableHead>
                            <TableHead>Schedule Name</TableHead>
                            <TableHead>Handler</TableHead>
                            <TableHead>Cron</TableHead>
                            <TableHead>Timezone</TableHead>
                            <TableHead>Total Runs</TableHead>
                            <TableHead>Next Run</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {isLoading ? (
                            <TableRow>
                              <TableCell colSpan={8} className="text-center py-8">
                                <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                              </TableCell>
                            </TableRow>
                          ) : paginatedSchedules.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                                {scheduleSearchQuery
                                  ? `No schedules found matching "${scheduleSearchQuery}"`
                                  : "No schedules found"
                                }
                              </TableCell>
                            </TableRow>
                          ) : (
                            paginatedSchedules.map((schedule: Schedule) => (
                              <TableRow
                                key={schedule.id}
                                className="hover:bg-muted/50 transition-colors cursor-pointer"
                                onClick={() => openScheduleDetail(schedule)}
                              >
                                <TableCell>
                                  <ScheduleStatusBadge status={schedule.status} />
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                  {schedule.name}
                                </TableCell>
                                <TableCell className="font-mono text-sm text-muted-foreground">
                                  {schedule.handlerName}
                                </TableCell>
                                <TableCell className="font-mono text-xs bg-secondary/30 px-2 py-1 rounded">
                                  {schedule.cron}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {schedule.timezone}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {schedule.totalRuns.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground" suppressHydrationWarning>
                                  {schedule.nextRunAt
                                    ? formatDistanceToNow(new Date(schedule.nextRunAt), { addSuffix: true })
                                    : "—"}
                                </TableCell>
                                <TableCell className="text-right">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        className="gap-2"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openScheduleDetail(schedule);
                                        }}
                                      >
                                        <Eye className="h-4 w-4" />
                                        View Details
                                      </DropdownMenuItem>
                                      {schedule.status === "ACTIVE" && (
                                        <DropdownMenuItem
                                          className="gap-2"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handlePauseSchedule(schedule);
                                          }}
                                        >
                                          <PauseCircle className="h-4 w-4" />
                                          Pause Schedule
                                        </DropdownMenuItem>
                                      )}
                                      {schedule.status === "PAUSED" && (
                                        <DropdownMenuItem
                                          className="gap-2"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleResumeSchedule(schedule);
                                          }}
                                        >
                                          <PlayCircle className="h-4 w-4" />
                                          Resume Schedule
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem
                                        className="gap-2 text-destructive"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteSchedule(schedule);
                                        }}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                        Delete Schedule
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Schedules Pagination */}
                    {totalSchedulePages > 1 && (
                      <div className="flex items-center justify-between mt-4">
                        <p className="text-sm text-muted-foreground">
                          Showing {Math.min((schedulesPage - 1) * ITEMS_PER_PAGE + 1, filteredSchedules.length)} to{" "}
                          {Math.min(schedulesPage * ITEMS_PER_PAGE, filteredSchedules.length)} of {filteredSchedules.length} schedules
                        </p>
                        <Pagination>
                          <PaginationContent>
                            <PaginationItem>
                              <PaginationPrevious
                                onClick={() => setSchedulesPage((p) => Math.max(1, p - 1))}
                                className={schedulesPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                              />
                            </PaginationItem>

                            {Array.from({ length: Math.min(5, totalSchedulePages) }, (_, i) => {
                              let pageNum: number;
                              if (totalSchedulePages <= 5) {
                                pageNum = i + 1;
                              } else if (schedulesPage <= 3) {
                                pageNum = i + 1;
                              } else if (schedulesPage >= totalSchedulePages - 2) {
                                pageNum = totalSchedulePages - 4 + i;
                              } else {
                                pageNum = schedulesPage - 2 + i;
                              }

                              return (
                                <PaginationItem key={pageNum}>
                                  <PaginationLink
                                    onClick={() => setSchedulesPage(pageNum)}
                                    isActive={schedulesPage === pageNum}
                                    className="cursor-pointer"
                                  >
                                    {pageNum}
                                  </PaginationLink>
                                </PaginationItem>
                              );
                            })}

                            <PaginationItem>
                              <PaginationNext
                                onClick={() => setSchedulesPage((p) => Math.min(totalSchedulePages, p + 1))}
                                className={schedulesPage === totalSchedulePages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                              />
                            </PaginationItem>
                          </PaginationContent>
                        </Pagination>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* Job Detail Modal */}
      <JobDetailModal
        job={selectedJob}
        open={isJobModalOpen}
        onOpenChange={setIsJobModalOpen}
        onRetry={handleRetryJob}
        onCancel={handleCancelJob}
      />

      {/* Schedule Detail Modal */}
      <ScheduleDetailModal
        schedule={selectedSchedule}
        open={isScheduleModalOpen}
        onOpenChange={setIsScheduleModalOpen}
        onPause={handlePauseSchedule}
        onResume={handleResumeSchedule}
        onDelete={handleDeleteSchedule}
      />
    </div>
  );
}
