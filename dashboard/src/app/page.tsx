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
import { StatsCard } from "@/components/stats-card";
import { JobDetailModal } from "@/components/job-detail-modal";
import {
  fetchJobs,
  fetchStats,
  cancelJob,
  retryJob,
  type Job,
  type JobStatus,
  type Stats,
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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const ITEMS_PER_PAGE = 20;
const FETCH_LIMIT = 200; // Fetch more for client-side search filtering

export default function DashboardPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTab, setSelectedTab] = useState<JobStatus | "ALL">("ALL");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Data states
  const [allJobs, setAllJobs] = useState<Job[]>([]); // All fetched jobs
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

  // Client-side filtering for search
  const filteredJobs = allJobs.filter((job) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      job.name.toLowerCase().includes(query) ||
      job.id.toLowerCase().includes(query)
    );
  });

  // Paginated jobs
  const paginatedJobs = filteredJobs.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const totalPages = Math.ceil(filteredJobs.length / ITEMS_PER_PAGE);

  // Reset page when search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  // Fetch data function
  const loadData = useCallback(async (showRefreshSpinner = false) => {
    try {
      if (showRefreshSpinner) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      // Fetch jobs and stats in parallel
      // Don't send search to backend (backend only supports exact match)
      const [jobsResponse, statsResponse] = await Promise.all([
        fetchJobs({
          status: selectedTab,
          limit: FETCH_LIMIT,
        }),
        fetchStats(),
      ]);

      setAllJobs(jobsResponse.jobs);
      setStats(statsResponse);
    } catch (err: any) {
      console.error("Failed to load data:", err);
      setError(err.message || "Failed to connect to server");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [selectedTab]);

  // Initial load and when dependencies change
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset page when tab changes
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedTab]);

  const openJobDetail = (job: Job) => {
    setSelectedJob(job);
    setIsModalOpen(true);
  };

  const handleCancel = async (job: Job) => {
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

  const handleRetry = async (job: Job) => {
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/20">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Activity className="h-6 w-6 text-white" />
              </div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8 animate-in">
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
        </div>

        {/* Jobs Table  */}
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

            {/* Tabs */}
            <Tabs value={selectedTab} onValueChange={(v) => setSelectedTab(v as typeof selectedTab)}>
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
                <TabsTrigger value="FAILED">
                  Failed <span className="ml-2 text-xs opacity-60">({stats?.failedCount || 0})</span>
                </TabsTrigger>
                <TabsTrigger value="DEAD">
                  Dead <span className="ml-2 text-xs opacity-60">({stats?.deadCount || 0})</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value={selectedTab} className="mt-4">
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
                                        handleRetry(job);
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
                                        handleCancel(job);
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

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-sm text-muted-foreground">
                      Showing {Math.min((currentPage - 1) * ITEMS_PER_PAGE + 1, filteredJobs.length)} to{" "}
                      {Math.min(currentPage * ITEMS_PER_PAGE, filteredJobs.length)} of {filteredJobs.length} jobs
                    </p>
                    <Pagination>
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                          />
                        </PaginationItem>

                        {/* Show page numbers */}
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          let pageNum: number;
                          if (totalPages <= 5) {
                            pageNum = i + 1;
                          } else if (currentPage <= 3) {
                            pageNum = i + 1;
                          } else if (currentPage >= totalPages - 2) {
                            pageNum = totalPages - 4 + i;
                          } else {
                            pageNum = currentPage - 2 + i;
                          }

                          return (
                            <PaginationItem key={pageNum}>
                              <PaginationLink
                                onClick={() => setCurrentPage(pageNum)}
                                isActive={currentPage === pageNum}
                                className="cursor-pointer"
                              >
                                {pageNum}
                              </PaginationLink>
                            </PaginationItem>
                          );
                        })}

                        <PaginationItem>
                          <PaginationNext
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
      </main>

      {/* Job Detail Modal */}
      <JobDetailModal
        job={selectedJob}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onRetry={handleRetry}
        onCancel={handleCancel}
      />
    </div>
  );
}
