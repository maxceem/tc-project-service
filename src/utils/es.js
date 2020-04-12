/**
 * Methods to index data from DB in ES.
 */
import _ from 'lodash';
import config from 'config';
import Promise from 'bluebird';
import util from '../util';
import models from '../models';
import { MAPPINGS } from './es-config';

const ES_METADATA_INDEX = config.get('elasticsearchConfig.metadataIndexName');
const ES_METADATA_TYPE = config.get('elasticsearchConfig.metadataDocType');
const ES_METADATA_DEFAULT_ID = config.get('elasticsearchConfig.metadataDocDefaultId');

const eClient = util.getElasticSearchClient();

const modelConfigs = {
  ProjectTemplate: {
    indexProperty: 'projectTemplates',
  },
  ProductTemplate: {
    indexProperty: 'productTemplates',
  },
  ProjectType: {
    indexProperty: 'projectTypes',
  },
  ProductCategory: {
    indexProperty: 'productCategories',
  },
  MilestoneTemplate: {
    indexProperty: 'milestoneTemplates',
  },
  OrgConfig: {
    indexProperty: 'orgConfigs',
  },
  Form: {
    indexProperty: 'forms',
  },
  PlanConfig: {
    indexProperty: 'planConfigs',
  },
  PriceConfig: {
    indexProperty: 'priceConfigs',
  },
  BuildingBlock: {
    indexProperty: 'buildingBlocks',
  },
};

/**
 * Index metadata models defined by `modelConfigs`
 *
 * @returns {Promise} esClient.index result
 */
async function indexMetadata() {
  const modelNames = _.keys(modelConfigs);
  const body = {
    id: ES_METADATA_DEFAULT_ID,
  };

  for (let i = 0; i < modelNames.length; i += 1) {
    const modelName = modelNames[i];
    const modelConfig = modelConfigs[modelName];
    const records = await models[modelName].findAll({ raw: true }); // eslint-disable-line no-await-in-loop

    body[modelConfig.indexProperty] = records;
  }

  // TODO add check that there is no data in ES_METADATA_INDEX yet, or throw an error

  return eClient.index({
    index: ES_METADATA_INDEX,
    type: ES_METADATA_TYPE,
    id: ES_METADATA_DEFAULT_ID,
    body,
    refresh: 'wait_for',
  });
}

/**
 * Build the request for creating index
 *
 * @param {String} indexName the index name
 * @param {String} docType   docType for index
 *
 * @return {Object} create index request
 */
function buildCreateIndexRequest(indexName, docType) {
  const indexMapping = MAPPINGS[indexName];

  if (!indexMapping) {
    throw new Error(`Mapping is not found for index name '${indexName}'.`);
  }

  const indexCreateRequest = {
    index: indexName,
    updateAllTypes: true,
    body: {
      mappings: {},
    },
  };
  indexCreateRequest.body.mappings[docType] = indexMapping;

  return indexCreateRequest;
}

const PROJECT_ATTRIBUTES = _.without(
  _.keys(models.Project.rawAttributes),
  'utm',
  'deletedAt',
);
const PROJECT_MEMBER_ATTRIBUTES = _.without(
  _.keys(models.ProjectMember.rawAttributes),
  'deletedAt',
);
const ES_PROJECT_INDEX = config.get('elasticsearchConfig.indexName');
const ES_PROJECT_TYPE = config.get('elasticsearchConfig.docType');

/**
 * prepare project for indexing
 *
 * @param {object} projectObj project object
 * @param {object} logger logger
 * @param {object} usersCache users cache
 * @param {object} fields fields to index
 * @param {int} requestId   request Id
 * @param {function} completedCallback   callback function
 *
 * @return {Object} create index request
 */
function prepareProject(projectObj, logger, usersCache, fields, requestId, completedCallback) {
  if (!projectObj) {
    return Promise.resolve(null);
  }
  const project = projectObj.toJSON();
  const membersCache = usersCache;
  logger.debug('phases', project.phases);
  if (project.phases) {
    // removs the delete audit fields from the index data
    project.phases = project.phases.map(phase =>
      _.omit(phase, ['deletedAt', 'deletedBy']),
    );
  }
  return models.ProjectMember.getActiveProjectMembers(project.id)
    .then((currentProjectMembers) => {
      logger.debug('currentProjectMembers : ', currentProjectMembers);
      // check context for project members
      project.members = _.map(currentProjectMembers, m =>
        _.pick(m, fields.project_members),
      );
      logger.debug('project.members => ', project.members);
      const userIds = project.members ? _.map(project.members, 'userId') : [];
      logger.debug('userIds => ', userIds);
      const newUsersIds = [];
      userIds.forEach((userId) => {
        if (!membersCache[userId]) {
          newUsersIds.push(userId);
        }
      });
      if (newUsersIds.length > 0) {
        logger.debug('getting details for userIds', newUsersIds);
        return util
          .getMemberDetailsByUserIds(
            newUsersIds,
            logger,
            requestId,
          )
          .then((membersDetails) => {
            logger.debug('membersDetails => ', membersDetails);
            membersDetails.forEach((md) => {
              membersCache[md.userId] = md;
            });
            // update project member record with details
            project.members = project.members.map((single) => {
              const detail = membersCache[single.userId];
              return _.merge(
                single,
                _.pick(detail, 'handle', 'firstName', 'lastName', 'email'),
              );
            });
            logger.debug(
              'After adding details, project.members => ',
              project.members,
            );
            return Promise.delay(1000).return(project);
          })
          .catch((error) => {
            logger.error(
              `Error in getting project member details for (projectId: ${project.id})`,
              error,
            );
            completedCallback(error);
            return null;
          });
      }
        // update project member record with details
      project.members = project.members.map((single) => {
        const detail = membersCache[single.userId];
        return _.merge(
            single,
            _.pick(detail, 'handle', 'firstName', 'lastName', 'email'),
          );
      });
      logger.debug(
          'After adding details, project.members => ',
          project.members,
        );
      return Promise.delay(1000).return(project);
    })
    .catch((error) => {
      logger.error(
        `Error in getting project active members (projectId: ${project.id})`,
        error,
      );
      completedCallback(error);
      return null;
    });
}

/**
 * Index projects to ES by range of ids
 *
 * @param {object} projectIndexingParameters object contains these properties
 * logger,projectIdStart, projectIdEnd, indexName, docType, fields, id
 * @param {function} beforeBulkIndexingCallback   function to be called when data is ready for peforming ES indexing
 * @param {function} completedCallback   function to be called if operations succeed or fails
 *
 * @return {Promise}              Returns a promise
 */
function indexProjectsRange(
  projectIndexingParameters,
  beforeBulkIndexingCallback,
  completedCallback,
) {
  const logger = projectIndexingParameters.logger;
  logger.debug('Entered Admin#index');
  const projectIdStart = projectIndexingParameters.projectIdStart;
  const projectIdEnd = projectIndexingParameters.projectIdEnd;
  const indexName = projectIndexingParameters.indexName || ES_PROJECT_INDEX;
  const docType = projectIndexingParameters.docType || ES_PROJECT_TYPE;
  logger.debug('projectIdStart', projectIdStart);
  logger.debug('projectIdEnd', projectIdEnd);
  logger.debug('indexName', indexName);
  logger.debug('docType', docType);
  let fields = projectIndexingParameters.fields;
  fields = fields ? fields.split(',') : [];
  // parse the fields string to determine what fields are to be returned
  fields = util.parseFields(fields, {
    projects: PROJECT_ATTRIBUTES,
    project_members: PROJECT_MEMBER_ATTRIBUTES,
  });
  logger.debug('fields', fields);

  const membersCache = {};
  return models.Project.findProjectRange(
    models,
    projectIdStart,
    projectIdEnd,
    fields,
    false,
  )
    .then((_projects) => {
      logger.debug('Projects in range: ', _projects.length);

      const projectResponses = [];
      const allProjectsProcessedHandler = () => {
        const body = [];
        projectResponses.map((p) => {
          if (p) {
            body.push({
              index: { _index: indexName, _type: docType, _id: p.id },
            });
            body.push(p);
          }
          // dummy return
          return p;
        });
        logger.debug('body.length', body.length);
        if (body.length > 0) {
          logger.trace('body[0]', body[0]);
          logger.trace('body[length-1]', body[body.length - 1]);
        }
        if (beforeBulkIndexingCallback) {
          beforeBulkIndexingCallback(body);
        }
        // bulk index
        if (body.length > 0) {
          eClient
            .bulk({
              body,
            })
            .then((result) => {
              logger.debug(
                `project indexed successfully (projectId: ${projectIdStart}-${projectIdEnd})`,
                result,
              );
              logger.debug(result);
              completedCallback();
            })
            .catch((error) => {
              logger.error(
                `Error in indexing project (projectId: ${projectIdStart}-${projectIdEnd})`,
                error,
              );
              completedCallback(error);
            });
        } else {
          completedCallback();
        }
      };
      const prepareProjectHandler = (project) => {
        if (project) {
          projectResponses.push(project);
        }
        if (_projects.length > 0) {
          const projectObj = _projects.pop();
          prepareProject(projectObj, logger, membersCache, fields, projectIndexingParameters.id, completedCallback)
            .then(prepareProjectHandler)
            .catch((error) => {
              logger.error(
                `Error in getting projects details for indexing (projectId: ${projectIdStart}-${projectIdEnd})`,
                error,
              );
              completedCallback(error);
            });
        } else {
          allProjectsProcessedHandler();
        }
      };
      prepareProject(_projects.pop(), logger, membersCache, fields, projectIndexingParameters.id, completedCallback)
        .then(prepareProjectHandler)
        .catch((error) => {
          logger.error(
            `Error in getting projects details for indexing (projectId: ${projectIdStart}-${projectIdEnd})`,
            error,
          );
        });
    })
    .catch((error) => {
      completedCallback(error);
    });
}

module.exports = {
  indexMetadata,
  indexProjectsRange,
  buildCreateIndexRequest,
};
