class DataProvider {
  constructor(props) {
    // TODO props validation
    const { dataProvider, resources, paramsPatch } = props;

    this.paramsPatch = paramsPatch;
    this.dataProvider = dataProvider;

    this.resourceMappings = {};
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      if (!resource.resourceName || !resource.dataProviderMappings) {
        continue;
      }
      this.resourceMappings[resource.resourceName] =
        resource.dataProviderMappings;
    }

    this.actionHandlers = {
      GET_LIST: this.handleGetList,
      GET_ONE: this.handleGetOne,
      UPDATE: this.handleUpdate,
      CREATE: this.handleCreate,
      DELETE: this.handleDelete,
      DELETE_MANY: this.handleDeleteMany
    };
  }

  actionToMappingType = {
    GET_LIST: 'LIST',
    GET_ONE: 'EDIT',
    UPDATE: 'EDIT',
    CREATE: 'CREATE',
    DELETE: 'DELETE',
    DELETE_MANY: 'DELETE'
  };

  provideData = (type, resource, params) => {
    let newParams;
    if (this.paramsPatch) {
      newParams = this.paramsPatch(type, params);
    }

    const mappings = this.resourceMappings[resource];
    const mappingType = this.actionToMappingType[type];
    if (mappings && mappingType) {
      return this.actionHandlers[type](newParams, mappings[mappingType]);
    }
    return this.dataProvider(type, resource, newParams);
  };

  handleGetList = async (params, resources) => {
    const { queries, totalRecords } = await this.runGetQueries({
      mainType: 'GET_LIST',
      params,
      resources,
      getTotal: true
    });

    const total = await totalRecords;
    const result = await this.handleGetQueries(queries, resources);
    const data = Object.values(result);
    return {
      data,
      total
    };
  };

  handleGetOne = async (params, resources) => {
    const { queries } = await this.runGetQueries({
      mainType: 'GET_ONE',
      params,
      resources,
      getTotal: false
    });

    const result = await this.handleGetQueries(queries, resources);
    const data = Object.values(result)[0];
    // going back from array to object & adding id required by react-admin
    return {
      data: Object.assign({}, data, { id: parseInt(params.id) })
    };
  };

  hasAccumulateResource = resources => {
    for (let resourceName in resources) {
      if (resources[resourceName].accumulate) {
        return true;
      }
    }
    return false;
  };

  getNonIdField = data => {
    for (let key in data) {
      if (key !== 'id') {
        return key;
      }
    }
    return null;
  };

  buildHashForData = data => {
    const dataHash = {};
    for (let index in data) {
      const value = data[index];
      dataHash[value] = true;
    }
    return dataHash;
  };

  createDiff = (data, previousData) => {
    /**
     * Generates list of new records to add to db
     */
    const nonIdField = this.getNonIdField(data);
    const dataHash = previousData
      ? this.buildHashForData(previousData[nonIdField])
      : {};

    const recordsToAdd = [];
    for (let index in data[nonIdField]) {
      const value = data[nonIdField][index];
      if (!dataHash[value]) {
        const recordToAdd = {};
        for (let key in data) {
          if (key === 'id') {
            continue;
          }
          recordToAdd[key] = data[key][index];
        }
        recordsToAdd.push(recordToAdd);
      }
    }
    return recordsToAdd;
  };

  deleteDiff = (previousData, data) => {
    /**
     * Generates list of ids to delete from db
     */
    if (!previousData) {
      return [];
    }

    const nonIdField = this.getNonIdField(previousData);
    const dataHash = this.buildHashForData(data[nonIdField]);

    const idsToDelete = [];
    for (let index in previousData[nonIdField]) {
      const value = previousData[nonIdField][index];
      if (!dataHash[value]) {
        idsToDelete.push(previousData.id[index]);
      }
    }

    return idsToDelete;
  };

  runAccumulateQueries = (params, resource, resourceName) => {
    const idsToDelete = this.deleteDiff(resource.previousData, resource.data);
    idsToDelete.forEach(id => {
      this.dataProvider('DELETE', resourceName, {
        id,
        previousData: {}
      });
    });

    let queries = [];
    let newRecords = this.createDiff(resource.data, resource.previousData);
    newRecords.forEach(record => {
      const query = this.dataProvider('CREATE', resourceName, {
        data: Object.assign({}, record, resource.getForeignKey(params.id))
      });
      queries.push(query);
    });

    const newIds = [];
    for (let index in resource.data.id) {
      const newId = resource.data.id[index];
      if (idsToDelete.includes(newId)) {
        continue;
      }
      newIds.push(newId);
    }

    return Promise.all(queries).then(results => {
      results.forEach(result => {
        newIds.push(result.data.id);
      });
      return {
        data: {
          ...resource.data,
          id: newIds
        }
      };
    });
  };

  handleUpdate = async (params, resources) => {
    this.disaggregateData(params, resources, 'data');
    if (this.hasAccumulateResource(resources)) {
      /**
       * We need previousData for many-to-many relationships
       * TODO(mihail): we should build previousData only for accumulate
       * resource but I don't consider this to be a big overhead for now
       */
      this.disaggregateData(params, resources, 'previousData');
    }

    const { queries } = await this.runUpdateQueries({ params, resources });

    // clear resource.data
    for (let resourceName in resources) {
      resources[resourceName].data = {};
    }

    const result = await this.handleUpdateQueries(queries, resources);
    const data = Object.values(result)[0];
    const id = parseInt(Object.keys(result)[0]);
    return {
      id,
      data: Object.assign({}, data, { id })
    };
  };

  initParamsData = (params, resources) => {
    let newParams = params;
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      if (resource.initData) {
        newParams = Object.assign({}, params, {
          data: resource.initData(params.data)
        });
      }
    }
    return newParams;
  };

  handleCreate = async (params, resources) => {
    const newParams = this.initParamsData(params, resources);
    this.disaggregateData(newParams, resources, 'data');

    const {
      mainResourceData,
      mainResourceName,
      queries
    } = await this.runCreateQueries({ resources });

    // clear resource.data
    for (let resourceName in resources) {
      resources[resourceName].data = {};
    }

    const result = await this.handleCreateQueries(
      queries,
      resources,
      mainResourceData,
      mainResourceName
    );
    const data = Object.values(result)[0];
    const id = parseInt(Object.keys(result)[0]);
    return {
      data: Object.assign({}, data, { id })
    };
  };

  handleDelete = async (params, resources) => {
    return this.runDeleteQueries({ params, resources });
  };

  handleDeleteMany = async (params, resources) => {
    const getQueries = [];
    const deleteQueries = [];
    params.ids.forEach(id => {
      getQueries.push(this.handleGetOne({ id }, resources));
    });

    const records = await Promise.all(getQueries);
    records.forEach(record => {
      deleteQueries.push(
        this.handleDelete(
          { id: record.data.id, previousData: record.data },
          resources
        )
      );
    });

    const results = await Promise.all(deleteQueries);
    return {
      data: results.map(result => result.data.id)
    };
  };

  runGetQueries = ({ mainType, params, resources, getTotal = false }) => {
    const queries = [];
    let totalRecords = 0;
    for (let resourceName in resources) {
      const resource = resources[resourceName];

      let query;
      let newParams = params;
      if (resource.params) {
        newParams = resource.params(params);
      }
      if (resource.main) {
        query = this.dataProvider(mainType, resourceName, newParams);
        if (getTotal) {
          totalRecords = this.getAllRecords({
            resourceName,
            filter: newParams.filter
          }).then(res => res.data.length);
        }
      } else {
        // TODO maybe filter here...
        query = this.getAllRecords({ resourceName });
      }
      queries.push({
        query,
        resourceName
      });
    }

    return {
      queries,
      totalRecords
    };
  };

  handleGetQueries = async (queries, resources) => {
    const queryPromises = queries.map(query => query.query);
    const resourceNames = queries.map(query => query.resourceName);
    const resourcesData = await Promise.all(queryPromises);
    this.storeResourcesData(resourcesData, resourceNames, resources);
    return this.aggregateData(resources);
  };

  runUpdateQueries = ({ params, resources }) => {
    /**
     * I just need the data to be updated
     * no previousData
     */
    const queries = [];
    for (let resourceName in resources) {
      let query;
      const resource = resources[resourceName];
      if (!resource.accumulate) {
        query = this.runNonAccumulateUpdateQuery(resource, resourceName, params);
      } else {
        query = this.runAccumulateQueries(params, resource, resourceName);
      }
      queries.push({
        query,
        resourceName
      });
    }
    return {
      queries
    };
  };

  runNonAccumulateUpdateQuery = (resource, resourceName, params) => {
    let id;
    if (resource.main) {
      id = params.id;
    } else {
      id = resource.data.id;
    }
    return this.dataProvider('UPDATE', resourceName, {
      id,
      data: resource.data
    });
  };

  handleUpdateQueries = async (queries, resources) => {
    const queryPromises = queries.map(query => query.query);
    const resourceNames = queries.map(query => query.resourceName);

    // aggregate again and return result
    const resourcesData = await Promise.all(queryPromises);
    this.storeResourcesData(resourcesData, resourceNames, resources);
    return this.aggregateData(resources);
  };

  runCreateQueries = async ({ resources }) => {
    let mainResource;
    let mainResourceName;
    for (let resourceName in resources) {
      if (resources[resourceName].main) {
        mainResource = resources[resourceName];
        mainResourceName = resourceName;
        break;
      }
    }
    const mainResourceResult = await this.dataProvider('CREATE', mainResourceName, {
      data: mainResource.data
    });

    // run all other creates
    const queries = [];
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      if (resource.main) {
        continue;
      }

      let query;
      if (resource.accumulate) {
        query = this.runAccumulateQueries(
          { id: mainResourceResult.data.id },
          resource,
          resourceName
        );
      } else {
        query = this.dataProvider('CREATE', resourceName, {
          data: Object.assign(
            {},
            resource.data,
            resource.getForeignKey(mainResourceResult.data.id)
          )
        });
      }
      queries.push({
        query,
        resourceName
      });
    }

    return {
      mainResourceData: mainResourceResult,
      mainResourceName,
      queries
    };
  };

  handleCreateQueries = async (
    queries,
    resources,
    mainResourceData,
    mainResourceName
  ) => {
    const queryPromises = queries.map(query => query.query);
    const resourceNames = queries.map(query => query.resourceName);
    const resourcesData = await Promise.all(queryPromises);

    resourcesData.push(mainResourceData);
    resourceNames.push(mainResourceName);
    this.storeResourcesData(resourcesData, resourceNames, resources);
    return this.aggregateData(resources);
  };

  runDeleteQueries = ({ params, resources }) => {
    // delete from all other resources
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      if (resource.main) {
        continue;
      }

      if (resource.accumulate) {
        const idsToDelete = resource.getId(params.previousData);
        idsToDelete.forEach(id => {
          this.dataProvider('DELETE', resourceName, {
            id,
            previousData: {}
          });
        });
      } else {
        this.dataProvider('DELETE', resourceName, {
          id: resource.getId(params.previousData),
          previousData: {}
        });
      }
    }

    // delete from main resource
    for (let resourceName in resources) {
      if (resources[resourceName].main) {
        return this.dataProvider('DELETE', resourceName, {
          id: params.id,
          previousData: {}
        });
      }
    }

    // no main resource - should not happen
    return { data: null };
  };

  storeResourcesData = (resourcesData, resourceNames, resources) => {
    resourcesData.forEach(({ data: resourceData }, index) => {
      const resourceName = resourceNames[index];
      const resource = resources[resourceName];
      if (!Array.isArray(resourceData)) {
        resource.data = [resourceData];
      } else {
        resource.data = resourceData;
      }
    });
  };

  addFieldData = ({
    aggregatedData,
    row,
    key,
    field,
    accumulate = false
  }) => {
    let srcField, dstField;
    if (typeof field === 'string') {
      dstField = field;
      srcField = field;
    } else {
      dstField = field.alias;
      srcField = field.name;
    }

    if (accumulate) {
      if (aggregatedData[key][dstField]) {
        aggregatedData[key][dstField].push(row[srcField]);
      } else {
        aggregatedData[key][dstField] = [row[srcField]];
      }
    } else {
      aggregatedData[key][dstField] = row[srcField];
    }
  };

  aggregateData = resources => {
    /**
     * Aggregate data from resource.data, for each resource in resources
     * resource.data contains rows with all the fields
     * resource.fields specifies which fields to aggregate
     */
    const aggregatedData = {};

    let mainResource = Object.values(resources).find(resource => resource.main === true);
    mainResource.data.forEach(row => {
      const key = mainResource.key(row, resources);
      aggregatedData[key] = {};
      mainResource.fields.forEach(field => {
        this.addFieldData({
          aggregatedData,
          row,
          key,
          field,
          accumulate: false
        });
      });
    });

    // aggregate all other resource data
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      if (resource.main) {
        continue;
      }

      resource.data.forEach(row => {
        const key = resource.key(row, resources);
        if (!aggregatedData[key]) {
          // row has no relation with main resource data
          return;
        }

        resource.fields.forEach(field => {
          this.addFieldData({
            aggregatedData,
            row,
            key,
            field,
            accumulate: resource.accumulate
          });
        });
      });
    }
    return aggregatedData;
  };

  disaggregateData = (params, resources, key) => {
    /**
     * Splits data from params into resources (resource.data)
     *   key should be 'data' or 'previousData'
     */
    for (let resourceName in resources) {
      resources[resourceName][key] = {};
    }
    for (let paramName in params[key]) {
      this.updateParamInResources(paramName, params[key], resources, key);
    }
  };

  updateParamInResources = (paramName, paramsData, resources, key) => {
    /**
     * Looks for paramName in resources and
     * updates resource.data with its value
     */
    for (let resourceName in resources) {
      const resource = resources[resourceName];
      for (let fieldName of resource.fields) {
        if (typeof fieldName === 'string' && fieldName === paramName) {
          resource[key][fieldName] = paramsData[paramName];
          return;
        } else if (fieldName.alias === paramName) {
          resource[key][fieldName.name] = paramsData[paramName];
          return;
        }
      }
    }
  };

  getAllRecords = ({ resourceName, filter = {} }) => {
    return this.dataProvider('GET_LIST', resourceName, {
      pagination: { page: 1, perPage: 1 },
      sort: { field: 'id', order: 'DESC' },
      filter
    }).then(res => {
      return this.dataProvider('GET_LIST', resourceName, {
        pagination: { page: 1, perPage: res.total },
        sort: { field: 'id', order: 'DESC' },
        filter
      });
    });
  };
}

export default DataProvider;
