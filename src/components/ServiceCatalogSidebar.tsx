import React, { useState, useMemo } from 'react';
import { AWS_CATEGORIES, AWS_SERVICES_CATALOG } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import { Search, Plus, ChevronDown, ChevronRight, GripVertical, Layers } from 'lucide-react';

export function ServiceCatalogSidebar() {
  const [search, setSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const addServiceNode = useCloudStore((s) => s.addServiceNode);

  const filteredByCategory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map: Record<string, typeof AWS_SERVICES_CATALOG> = {};
    for (const cat of AWS_CATEGORIES) {
      const items = AWS_SERVICES_CATALOG.filter(
        (svc) =>
          svc.category === cat &&
          (!q ||
            svc.name.toLowerCase().includes(q) ||
            svc.shortName.toLowerCase().includes(q) ||
            svc.serviceCode.toLowerCase().includes(q) ||
            svc.terraformResourceType.toLowerCase().includes(q) ||
            svc.description.toLowerCase().includes(q))
      );
      if (items.length > 0) {
        map[cat] = items;
      }
    }
    return map;
  }, [search]);

  const onDragStart = (event: React.DragEvent, serviceType: string) => {
    event.dataTransfer.setData('application/localcloud-service', serviceType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  return (
    <aside className="w-[295px] shrink-0 h-full bg-[#0d1017] border-r border-slate-800/80 flex flex-col select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-800/80">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-orange-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              AWS Service Palette
            </span>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
            {AWS_SERVICES_CATALOG.length} Services
          </span>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search EC2, Lambda, S3, RDS, VPC..."
            className="w-full bg-[#141824] border border-slate-700/70 focus:border-orange-500/70 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          Drag onto the 2D canvas or click <span className="text-orange-400 font-medium">+</span> to spawn.
        </p>
      </div>

      {/* Categories & Draggable Service Cards */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
        {Object.entries(filteredByCategory).map(([category, services]) => {
          const isCollapsed = collapsedCategories[category] && !search;
          return (
            <div
              key={category}
              className="rounded-lg border border-slate-800/70 bg-[#11141d]/60 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleCategory(category)}
                className="w-full px-2.5 py-2 flex items-center justify-between text-left hover:bg-slate-800/40 transition-colors"
              >
                <span className="text-[11px] font-semibold text-slate-300 truncate">
                  {category}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] font-mono text-slate-400">
                    {services.length}
                  </span>
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </div>
              </button>

              {!isCollapsed && (
                <div className="p-1.5 pt-0 space-y-1">
                  {services.map((svc) => (
                    <div
                      key={svc.typeId}
                      draggable
                      onDragStart={(e) => onDragStart(e, svc.typeId)}
                      onClick={() => addServiceNode(svc.typeId)}
                      className="group flex items-center justify-between gap-2 p-2 rounded-lg bg-[#141824] hover:bg-[#1b2131] border border-transparent hover:border-slate-700/80 cursor-grab active:cursor-grabbing transition-all"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <GripVertical className="w-3 h-3 text-slate-600 group-hover:text-slate-400 shrink-0" />
                        <div
                          className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border"
                          style={{
                            backgroundColor: `${svc.color}18`,
                            borderColor: `${svc.color}40`,
                            color: svc.color,
                          }}
                        >
                          <AwsServiceIcon iconName={svc.iconName} className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-slate-200 group-hover:text-white truncate">
                              {svc.shortName}
                            </span>
                            <span className="text-[9px] font-mono text-slate-400 truncate">
                              {svc.serviceCode}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-400 truncate">
                            {svc.name}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          addServiceNode(svc.typeId);
                        }}
                        title={`Add ${svc.name} to canvas`}
                        className="w-6 h-6 rounded-md flex items-center justify-center bg-slate-800/80 group-hover:bg-orange-500 text-slate-400 group-hover:text-slate-950 transition-colors shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {Object.keys(filteredByCategory).length === 0 && (
          <div className="py-12 text-center text-xs text-slate-400">
            No AWS services match "{search}"
          </div>
        )}
      </div>
    </aside>
  );
}
